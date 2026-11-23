import { setTimeout as delay } from "node:timers/promises";

export async function classify(text, { signal } = {}) {
  const lower = text.toLowerCase();
  if (lower.includes("[timeout]")) await delay(1_200, undefined, { signal });
  if (lower.includes("[error]")) throw new Error("Mock provider unavailable");
  if (lower.includes("[bad-json]")) return "model output is not JSON";

  let topic = "other";
  const aboutShipment = lower.includes("заказ") || lower.includes("посылк");
  const aboutWhereOrStatus = lower.includes("где") || lower.includes("статус") || lower.includes("трек");
  if (lower.includes("достав") || (aboutShipment && aboutWhereOrStatus)) topic = "delivery";
  if (
    lower.includes("цен") ||
    lower.includes("стоим") ||
    lower.includes("стоит") ||
    lower.includes("расцен") ||
    lower.includes("оплат")
  ) {
    topic = "pricing";
  }
  if (lower.includes("[bad-topic]")) topic = "refund";

  return JSON.stringify({
    topic,
    draft: lower.includes("[empty-draft]") ? "  " : "Спасибо за обращение. Уточним детали заявки.",
  });
}
