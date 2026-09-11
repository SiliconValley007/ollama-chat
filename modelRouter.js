const CLOUD_MODEL_CHAIN = [
  'gpt-oss:120b-cloud',
  'gpt-oss:20b-cloud',
  'nemotron-3-nano:30b-cloud',
  'nemotron-3-super:cloud',
  'nemotron-3-ultra:cloud',
  'gemma4:31b-cloud'
];

// Broader than pure quota errors: also covers connection failures, timeouts, and
// server-side 5xx — all legitimate reasons to fail over to the next model in the chain.
function isRetryableError(err) {
  const msg = (err && err.message || '').toLowerCase();
  const code = err && err.code;
  return msg.includes('429') || msg.includes('quota') || msg.includes('rate limit') ||
    msg.includes('timeout') || msg.includes('econnrefused') || msg.includes('enotfound') ||
    msg.includes('502') || msg.includes('503') || msg.includes('504') ||
    code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT';
}

module.exports = { CLOUD_MODEL_CHAIN, isRetryableError };