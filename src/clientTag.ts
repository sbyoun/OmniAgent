/**
 * The tag that makes a pod's tmux session name say which machine opened it.
 *
 * Session names used to be `omniagent-<pod id>`, and pod ids come from a
 * counter each client keeps for itself — so a Mac and a Windows box managing
 * the same server both arrive at `omniagent-pod-7` sooner or later. An owned
 * pod attaches-or-creates, so the second one silently attached to the first:
 * two machines mirroring one screen, and closing the pod on either killed the
 * other's work. New pods are named `omniagent-<tag>-pod-N`, with the tag the
 * client's own hostname — unique per box, and readable in the sidebar, where
 * "win-pod-10" says who started it. Pods saved before this keep the old name
 * (it is in their layout entry, or derived from the id), so nothing migrates.
 */

/**
 * Turn a hostname into something a tmux session name can carry. tmux rejects
 * `.` and `:` in names, and a shell-quoted name is easier to trust when it is
 * only `[a-z0-9-]`: the first label of the name, lowercased, with runs of
 * anything else collapsed to a dash. Capped so a long corporate hostname does
 * not crowd out the pod number in the sidebar.
 */
export function sanitizeTag(hostname: string): string {
  const label = hostname.trim().split(".")[0] ?? "";
  const words = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .split("-")
    .filter(Boolean);
  // Cut at a dash rather than mid-word: "sunbumyoun-macbookpro-…" becomes
  // "sunbumyoun", not "sunbumyoun-macbo". A first word longer than the cap
  // is the one case that has to be cut through.
  let tag = "";
  for (const w of words) {
    const next = tag ? `${tag}-${w}` : w;
    if (next.length > MAX_TAG) break;
    tag = next;
  }
  if (!tag && words[0]) tag = words[0].slice(0, MAX_TAG);
  return tag || "client";
}

const MAX_TAG = 16;

