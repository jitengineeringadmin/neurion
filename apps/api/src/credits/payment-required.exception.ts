import { HttpException, HttpStatus } from '@nestjs/common';

/** HTTP 402 — used when a user has insufficient credits. */
export class PaymentRequiredException extends HttpException {
  constructor(message = 'Payment Required') {
    super(message, HttpStatus.PAYMENT_REQUIRED);
  }
}
