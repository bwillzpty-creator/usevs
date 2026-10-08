(function registerPaymentClient(root) {
  function createIdempotencyKey() {
    if (!root.crypto || typeof root.crypto.randomUUID !== 'function') {
      throw new Error('Secure UUID generation is not available in this browser.');
    }
    return root.crypto.randomUUID();
  }

  function createPaymentRequest(payload, idempotencyKey = createIdempotencyKey()) {
    return {
      idempotencyKey,
      options: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Idempotency-Key': idempotencyKey },
        credentials: 'same-origin',
        body: JSON.stringify(payload)
      }
    };
  }

  root.PaymentClient = { createIdempotencyKey, createPaymentRequest };
})(globalThis);