import { storageOf } from "./storageOf.ts"
import type { Descriptor } from "../types.ts"

/**
 * Can this workspace JUDGE a mirror held in `repo`? A mirror is kept between records of one repo, so
 * its truth is the owners in THAT repo — which a reader here sees only when it reads the owner
 * collection from that repo too. A record layer that contributes `projects` but not `tasks` holds
 * mirrors justified by tasks this workspace never reads: judged from here they all look stale, and
 * `relations rebuild` once deleted them inside the layer's clone. Those are the layer's own check's.
 */
export function ownersReadIn(ownerDescriptor: Descriptor, repo: string): boolean {
  return storageOf(ownerDescriptor).roots.some(r => r.repo === repo)
}
