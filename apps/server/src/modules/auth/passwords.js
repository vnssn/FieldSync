import argon2 from 'argon2';

const options = { type: argon2.argon2id, memoryCost: 19456, timeCost: 2, parallelism: 1 };
export function hashPassword(password) {
  return argon2.hash(password, options);
}

// Unknown accounts still perform Argon2 verification to reduce account-enumeration timing differences.
let dummyHash;
export async function verifyPassword(hash, password) {
  if (!hash) dummyHash ??= hashPassword('unused-account-placeholder-password');
  const verified = await argon2.verify(hash ?? await dummyHash, password);
  return Boolean(hash) && verified;
}
