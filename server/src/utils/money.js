export function roundMoney(value) {
    return Math.round(
        (Number(value || 0) + Number.EPSILON) *
        100
    ) / 100;
}

export function toMoney(value) {
    return roundMoney(value);
}

export function multiplyMoney(
    amount,
    quantity
) {
    return roundMoney(
        Number(amount || 0) *
        Number(quantity || 0)
    );
}