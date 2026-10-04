// プロセスの CPU アフィニティ（使ってよい論理プロセッサ）を設定する。Worker のスレッドにも効く。
// Deno に API がないので Windows の SetProcessAffinityMask を FFI で呼ぶ（--allow-ffi が必要）。
//
// i7-14700F の論理プロセッサ: 0〜15 = P コア 8 個 × 2 スレッド（2k, 2k+1 が同じコア）、16〜27 = E コア 12 個
// 例: 0xFFF5500 = P コア 4〜7 の 1 スレッド目（8, 10, 12, 14）+ E コア全部（16〜27）

export function parseMask(s: string): bigint {
  const v = BigInt(s.trim().toLowerCase().startsWith("0x") ? s.trim() : `0x${s.trim()}`);
  if (v <= 0n) throw new Error(`invalid affinity mask: ${s}`);
  return v;
}

export function popcount(mask: bigint): number {
  let n = 0;
  for (let m = mask; m > 0n; m >>= 1n) n += Number(m & 1n);
  return n;
}

/** 論理プロセッサ番号の一覧（表示用） */
export function cpuList(mask: bigint): number[] {
  const out: number[] = [];
  for (let i = 0, m = mask; m > 0n; i++, m >>= 1n) if (m & 1n) out.push(i);
  return out;
}

export function setProcessAffinity(mask: bigint): void {
  if (Deno.build.os !== "windows") throw new Error("--affinity is supported only on Windows");
  const k32 = Deno.dlopen("kernel32.dll", {
    GetCurrentProcess: { parameters: [], result: "pointer" },
    SetProcessAffinityMask: { parameters: ["pointer", "usize"], result: "i32" },
    GetLastError: { parameters: [], result: "u32" },
  } as const);
  try {
    const ok = k32.symbols.SetProcessAffinityMask(k32.symbols.GetCurrentProcess(), mask);
    if (!ok) throw new Error(`SetProcessAffinityMask failed (error ${k32.symbols.GetLastError()})`);
  } finally {
    k32.close();
  }
}
