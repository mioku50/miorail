// T19.2: legacy deep-link alias. The canonical Action Inbox deep link is now
// /actions/:actionId (see app/actions/[actionId]/page.tsx). This route keeps
// old /inbox/:actionId links working by redirecting to the canonical path.
import { redirect } from "next/navigation";

export default async function LegacyInboxAlias({
  params,
}: {
  params: Promise<{ actionId: string }>;
}) {
  const { actionId } = await params;
  redirect(`/actions/${actionId}`);
}
