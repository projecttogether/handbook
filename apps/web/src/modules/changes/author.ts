import { useT } from "@/i18n";
import { messages } from "./messages";

/** "Ada Lovelace via Claude", or "Someone" when the author is gone. */
export function useAuthorLabel() {
  const t = useT(messages);
  return (author: { name: string } | null, clientName: string | null) => {
    const name = author?.name || t("unknownAuthor");
    return clientName ? `${name} ${t("via", { client: clientName })}` : name;
  };
}
