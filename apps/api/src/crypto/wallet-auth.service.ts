import { BadRequestException, Injectable, UnauthorizedException } from '@nestjs/common';
import { randomBytes } from 'node:crypto';
import { ethers } from 'ethers';
import { PrismaService } from '../prisma/prisma.service';

/**
 * SIWE-style wallet linking. Server issues a nonce; client signs a message
 * containing it; server recovers the address and links it to the user.
 * Non-custodial — private keys never touch the backend.
 */
@Injectable()
export class WalletAuthService {
  constructor(private readonly prisma: PrismaService) {}

  private message(address: string, nonce: string): string {
    return `Neurion wants you to sign in with your wallet.\nAddress: ${address}\nNonce: ${nonce}`;
  }

  async createNonce(address: string): Promise<{ address: string; nonce: string; message: string }> {
    if (!ethers.isAddress(address)) throw new BadRequestException('invalid address');
    const normalized = ethers.getAddress(address);
    const nonce = randomBytes(16).toString('hex');
    await this.prisma.walletNonce.create({
      data: { address: normalized, nonce, expiresAt: new Date(Date.now() + 10 * 60 * 1000) },
    });
    return { address: normalized, nonce, message: this.message(normalized, nonce) };
  }

  async verify(userId: string, address: string, nonce: string, signature: string) {
    if (!ethers.isAddress(address)) throw new BadRequestException('invalid address');
    const normalized = ethers.getAddress(address);

    const row = await this.prisma.walletNonce.findFirst({
      where: { address: normalized, nonce, used: false, expiresAt: { gt: new Date() } },
    });
    if (!row) throw new UnauthorizedException('invalid or expired nonce');

    let recovered: string;
    try {
      recovered = ethers.verifyMessage(this.message(normalized, nonce), signature);
    } catch {
      throw new UnauthorizedException('bad signature');
    }
    if (ethers.getAddress(recovered) !== normalized) {
      throw new UnauthorizedException('signature does not match address');
    }

    // Atomically consume the nonce: only the first concurrent verify flips
    // used:false -> true, so a nonce cannot link a wallet to two accounts.
    const claim = await this.prisma.walletNonce.updateMany({
      where: { id: row.id, used: false },
      data: { used: true },
    });
    if (claim.count !== 1) throw new UnauthorizedException('nonce already used');

    await this.prisma.user.update({ where: { id: userId }, data: { walletAddress: normalized } });
    return { walletAddress: normalized };
  }

  async disconnect(userId: string) {
    await this.prisma.user.update({ where: { id: userId }, data: { walletAddress: null } });
    return { walletAddress: null };
  }

  async me(userId: string) {
    const user = await this.prisma.user.findUniqueOrThrow({ where: { id: userId } });
    return { walletAddress: user.walletAddress, kycStatus: user.kycStatus };
  }
}
