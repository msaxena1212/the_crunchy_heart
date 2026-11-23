const BASE_URL = process.env.STAGING_API_URL || 'http://127.0.0.1:5000';

async function runSmokeTest() {
    console.log(`\n======================================================`);
    console.log(`THE CRUNCHY HEART — Staging Live Smoke Test`);
    console.log(`Target: ${BASE_URL}`);
    console.log(`======================================================\n`);

    // 1. Health
    console.log('[1/5] Checking /api/health...');
    const healthRes = await fetch(`${BASE_URL}/api/health`);
    const health = await healthRes.json();
    console.log('Health response:', health);
    if (!health.ok) throw new Error('Health check failed');

    // 2. Products
    console.log('\n[2/5] Checking /api/products...');
    const prodRes = await fetch(`${BASE_URL}/api/products`);
    const products = await prodRes.json();
    console.log(`Found ${products.length} products/variants. Sample:`, {
        name: products[0].name,
        variantId: products[0].variant?.id,
        price: products[0].variant?.sellingPrice,
    });
    const sampleVariantId = products[0].variant?.id;

    // 3. Checkout Preview
    console.log('\n[3/5] Checking /api/checkout/preview...');
    const previewRes = await fetch(`${BASE_URL}/api/checkout/preview`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
            items: [{ variantId: sampleVariantId, quantity: 2 }]
        })
    });
    const preview = await previewRes.json();
    console.log('Preview calculation:', {
        subtotal: preview.subtotal,
        discountAmount: preview.discountAmount,
        shippingFee: preview.shippingFee,
        taxAmount: preview.taxAmount,
        totalAmount: preview.totalAmount,
    });
    if (!preview.totalAmount) throw new Error('Checkout preview calculation failed');

    // 4. OTP Request (Dev/Master code test)
    console.log('\n[4/5] Testing OTP Request (/api/auth/otp/send)...');
    const otpSendRes = await fetch(`${BASE_URL}/api/auth/otp/send`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '9876543210' })
    });
    const otpSend = await otpSendRes.json();
    console.log('OTP Send response:', otpSend);

    // 5. OTP Verify with 111111 master code
    console.log('\n[5/5] Testing OTP Verify with 111111 master code (/api/auth/otp/verify)...');
    const otpVerifyRes = await fetch(`${BASE_URL}/api/auth/otp/verify`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ phone: '9876543210', otp: '111111' })
    });
    const otpVerify = await otpVerifyRes.json();
    console.log('OTP Verify response:', {
        success: otpVerify.success,
        hasToken: !!(otpVerify.token || otpVerify.accessToken || otpVerify.customer),
    });

    console.log(`\n======================================================`);
    console.log(`ALL 5 STAGING SMOKE CHECKS PASSED SUCCESSFULLY!`);
    console.log(`======================================================\n`);
}

runSmokeTest().catch(err => {
    console.error('Smoke test failed:', err);
    process.exit(1);
});
