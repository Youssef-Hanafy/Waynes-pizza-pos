import { describe, expect, it } from 'vitest';
import { orderPaymentNotice } from '@/lib/orders/payment-notice';

describe('public order payment confirmation', () => {
  it('confirms a captured online card order instead of showing the legacy test warning', () => {
    const notice = orderPaymentNotice({ payment_status: 'paid', payment_method: 'card', total_cents: 278 });
    expect(notice).toEqual({ confirmed: true, title: 'Payment received', description: 'Your card payment of $2.78 was received.' });
    expect(JSON.stringify(notice)).not.toMatch(/test|manual|no card payment/i);
  });
  it('identifies an unpaid manual order without claiming payment', () => {
    expect(orderPaymentNotice({ payment_status: 'unpaid', payment_method: 'test_manual', total_cents: 278 })).toMatchObject({ confirmed: false, title: 'TEST / MANUAL payment' });
  });
  it('does not describe a later manually paid order as a card charge', () => {
    expect(orderPaymentNotice({ payment_status: 'paid', payment_method: 'test_manual', total_cents: 278 })).toMatchObject({ confirmed: true, description: 'Your payment of $2.78 was received.' });
  });
  it.each(['unpaid', 'pending', 'unknown'])('does not encourage another payment for an uncertain card outcome: %s', payment_status => {
    expect(orderPaymentNotice({ payment_status, payment_method: 'card', total_cents: 278 })).toMatchObject({ confirmed: false, title: 'Payment confirmation pending', description: expect.stringContaining('before paying again') });
  });
  it.each([
    ['authorized', 'Card authorized'], ['failed', 'Payment unsuccessful'],
    ['refunded', 'Payment refunded'], ['partially_refunded', 'Payment partially refunded'],
  ])('accurately describes %s without claiming captured funds', (payment_status, title) => {
    expect(orderPaymentNotice({ payment_status, payment_method: 'card', total_cents: 278 })).toMatchObject({ confirmed: false, title });
  });
});
