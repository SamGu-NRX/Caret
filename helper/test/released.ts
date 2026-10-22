// Whether the helper has let go of an object: a WeakRef to it, a full collection, and nothing may still reach it. The
// strongest check a retention test can make, since it fails for any holder, not only the one the test knows about.
import v8 from "node:v8";
import vm from "node:vm";

v8.setFlagsFromString("--expose-gc");
const gc = vm.runInNewContext("gc") as () => void;

/** Whether nothing reaches `ref`'s object after full collections. Each turn lets a WeakRef read in the same job lapse. */
export async function released(ref: WeakRef<object>): Promise<boolean> {
  for (let i = 0; i < 3; i++) {
    await new Promise((r) => setTimeout(r, 0));
    gc();
  }
  return ref.deref() === undefined;
}
