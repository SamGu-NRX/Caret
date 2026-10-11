// The helper compiles against lib es2024 and @types/node, neither of which declares WebAssembly. The
// sandbox only constructs a capped Memory and reads its size, so this declares just that much.
declare namespace WebAssembly {
  interface MemoryDescriptor {
    initial: number;
    maximum?: number;
  }
  interface Memory {
    readonly buffer: ArrayBuffer;
    grow(delta: number): number;
  }
  var Memory: {
    prototype: Memory;
    new (descriptor: MemoryDescriptor): Memory;
  };
}
