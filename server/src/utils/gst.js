import {
    roundMoney
} from './money.js';

export function calculateInclusiveTax(
    grossAmount,
    taxRate = 18
) {
    const gross =
        Number(grossAmount || 0);

    const rate =
        Number(taxRate || 0);

    if (
        gross <= 0 ||
        rate <= 0
    ) {
        return {
            grossAmount:
                roundMoney(gross),

            taxableAmount:
                roundMoney(gross),

            taxAmount: 0,

            taxRate: rate
        };
    }

    const divisor =
        1 + rate / 100;

    const taxableAmount =
        roundMoney(
            gross / divisor
        );

    const taxAmount =
        roundMoney(
            gross - taxableAmount
        );

    return {
        grossAmount:
            roundMoney(gross),

        taxableAmount,

        taxAmount,

        taxRate: rate
    };
}