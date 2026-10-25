/**
 * Handing the host's attachment service to the pi-ai adapter.
 *
 * MiniMax's models accept images, and the catalog this plugin publishes says
 * so. But a pi-ai-backed route only accepts an image when the plugin supplies
 * the host's durable attachment store: the adapter refuses the request before
 * a byte reaches the gateway, with
 *
 *   pi-ai image input requires the durable attachment service
 *
 * That is a wiring gap on this side, not a model limitation. It is also easy
 * to leave broken, because both hooks are optional on `PiAiAdapterOptions` —
 * omitting them type-checks, and the failure appears only when a human
 * attaches an image. The tests beside this module pin the wiring so it cannot
 * be dropped silently again.
 *
 * @module dsh-connect-minimaxcode/image-input
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls in the `attachments` Context augmentation, which is what
// makes `ctx.get('attachments')` a typed read rather than an untyped one.
// `@deepseek-ai/dsh-llm-pi-ai` already peers on this package, so declaring the
// peer adds no installation burden — it only names a service this plugin now
// genuinely needs.
import type {} from '@deepseek-ai/dsh-attachment'
import { resolveImageAttachmentAccess } from '@deepseek-ai/dsh-llm'
import type { AdapterOptions } from './adapter.ts'

/**
 * The one filesystem method the attachment bridge needs.
 *
 * Typed structurally rather than imported so this plugin takes no dependency on
 * the filesystem package: the bridge only translates a host path into the tool
 * execution world, and a host without that service gets no path at all.
 */
interface HostPathMapper {
  processPathFromHostPath(hostPath: string): string | undefined
}

/**
 * Build the two image-input hooks from the services the host provides.
 *
 * Both services are read per request through `ctx.get` rather than declared as
 * startup injections: they may be provided after this plugin loads, and a host
 * without them must still start and serve text. A host that provides no
 * attachment store simply keeps refusing images, which is the old behaviour
 * rather than a new failure.
 *
 * `resolveImageAccess` is what lets a model read the normalized image from a
 * tool as well as see it inline. It degrades to `undefined` when the host
 * exposes no host-path mapping, and the adapter then reports no local copy.
 *
 * @param ctx - the plugin fiber whose services are read.
 * @returns The optional {@link AdapterOptions} hooks, ready to spread.
 */
export function imageInputHooks(
  ctx: Context,
): Pick<AdapterOptions, 'resolveAttachments' | 'resolveImageAccess'> {
  return {
    resolveAttachments: () => ctx.get('attachments'),
    resolveImageAccess: (attachments, ref) => resolveImageAttachmentAccess(
      attachments,
      hostPath => (ctx.get('fs') as HostPathMapper | undefined)?.processPathFromHostPath(hostPath),
      ref,
    ),
  }
}
