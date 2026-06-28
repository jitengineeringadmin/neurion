// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/access/Ownable.sol";

interface IStakingBond {
    function slash(address operator, uint256 amount, string calldata reason) external;
}

/**
 * Bonded dispute market over compute results. Anyone can challenge a node's
 * result by staking a bond; an arbiter resolves. This decentralizes WHO can
 * raise a dispute (skin-in-the-game, not just the operator) — the final
 * arbitration is the owner now and a committee/optimistic fraud-proof later.
 *
 * On an upheld dispute the operator is slashed via the staking bond (whose
 * treasury is set to this contract), the challenger is refunded + paid a share
 * of the slash; on a rejected (frivolous) dispute the challenger's bond is
 * forfeited to the protocol treasury.
 */
contract DisputeResolver is Ownable {
    IERC20 public immutable token;
    IStakingBond public immutable bond;
    address public protocolTreasury;
    uint256 public challengeBond; // NRN a challenger must stake to dispute
    uint256 public rewardBps; // challenger's share of an upheld slash (basis points)

    struct Dispute {
        address challenger;
        address operator;
        bytes32 jobId;
        uint256 bondAmount;
        bool resolved;
    }

    mapping(bytes32 => Dispute) public disputes; // disputeId => Dispute
    mapping(bytes32 => bool) public jobDisputed; // one open dispute per jobId

    event DisputeOpened(bytes32 indexed disputeId, address indexed operator, bytes32 indexed jobId, address challenger);
    event DisputeResolved(bytes32 indexed disputeId, bool upheld, uint256 slashed, uint256 challengerPaid);
    event ParamsUpdated(uint256 challengeBond, uint256 rewardBps, address protocolTreasury);

    constructor(
        address token_,
        address bond_,
        address protocolTreasury_,
        uint256 challengeBond_,
        uint256 rewardBps_,
        address initialOwner
    ) Ownable(initialOwner) {
        require(token_ != address(0) && bond_ != address(0) && protocolTreasury_ != address(0), "ZERO_ADDR");
        require(rewardBps_ <= 10_000, "BAD_BPS");
        token = IERC20(token_);
        bond = IStakingBond(bond_);
        protocolTreasury = protocolTreasury_;
        challengeBond = challengeBond_;
        rewardBps = rewardBps_;
    }

    /// Open a dispute against `operator` for `jobId`, staking the challenge bond.
    function openDispute(address operator, bytes32 jobId, string calldata /*evidenceUri*/) external returns (bytes32 disputeId) {
        require(operator != address(0), "ZERO_OP");
        require(!jobDisputed[jobId], "ALREADY_DISPUTED");
        disputeId = keccak256(abi.encodePacked(operator, jobId, msg.sender));
        require(disputes[disputeId].challenger == address(0), "DUP");
        require(token.transferFrom(msg.sender, address(this), challengeBond), "BOND_TRANSFER_FAILED");
        disputes[disputeId] = Dispute({ challenger: msg.sender, operator: operator, jobId: jobId, bondAmount: challengeBond, resolved: false });
        jobDisputed[jobId] = true;
        emit DisputeOpened(disputeId, operator, jobId, msg.sender);
    }

    /// Arbiter resolves. upheld => slash operator (funds arrive here as bond.treasury),
    /// refund challenger + pay reward share; rejected => challenger bond forfeited.
    function resolve(bytes32 disputeId, bool upheld, uint256 slashAmount) external onlyOwner {
        Dispute storage d = disputes[disputeId];
        require(d.challenger != address(0) && !d.resolved, "BAD_DISPUTE");
        d.resolved = true;

        uint256 challengerPaid = 0;
        uint256 slashed = 0;
        if (upheld) {
            if (slashAmount > 0) {
                bond.slash(d.operator, slashAmount, "dispute upheld"); // -> this contract (bond.treasury)
                slashed = slashAmount;
            }
            uint256 reward = (slashed * rewardBps) / 10_000;
            challengerPaid = d.bondAmount + reward;
            require(token.transfer(d.challenger, challengerPaid), "PAY_FAILED");
            if (slashed > reward) require(token.transfer(protocolTreasury, slashed - reward), "TREASURY_FAILED");
        } else {
            require(token.transfer(protocolTreasury, d.bondAmount), "FORFEIT_FAILED"); // frivolous challenge
        }
        emit DisputeResolved(disputeId, upheld, slashed, challengerPaid);
    }

    function setParams(uint256 challengeBond_, uint256 rewardBps_, address protocolTreasury_) external onlyOwner {
        require(rewardBps_ <= 10_000, "BAD_BPS");
        require(protocolTreasury_ != address(0), "ZERO_ADDR");
        challengeBond = challengeBond_;
        rewardBps = rewardBps_;
        protocolTreasury = protocolTreasury_;
        emit ParamsUpdated(challengeBond_, rewardBps_, protocolTreasury_);
    }
}
