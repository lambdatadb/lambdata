export async function hashPassword(plain: string): Promise<string> {
  return Bun.password.hash(plain, { algorithm: "bcrypt", cost: 11 });
}

export async function verifyPassword(plain: string, hash: string): Promise<boolean> {
  try {
    return await Bun.password.verify(plain, hash);
  } catch {
    return false;
  }
}

let dummyHash: Promise<string> | null = null;

function placeholderHash(): Promise<string> {
  if (!dummyHash) {
    const filler = Array.from(crypto.getRandomValues(new Uint8Array(24)), (b) => b.toString(16).padStart(2, "0")).join("");
    dummyHash = hashPassword(filler);
  }
  return dummyHash;
}

export function warmPasswordCheck(): Promise<void> {
  return placeholderHash().then(() => undefined);
}

export async function checkPassword(plain: string, hash: string | null | undefined): Promise<boolean> {
  if (hash) return verifyPassword(plain, hash);
  await verifyPassword(plain, await placeholderHash());
  return false;
}
