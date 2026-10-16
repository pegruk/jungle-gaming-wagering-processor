import { Money, type MoneyProps } from "../domain/value-objects/money";
import { TransactionType, type WagerRequest } from "../domain/entities/wager-transaction";

export class ApplicationError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
  ) {
    super(code);
    this.name = "ApplicationError";
  }
}

export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new ApplicationError(400, "INVALID_PAYLOAD");
  return value as Record<string, unknown>;
}

function text(value: unknown, max: number): string {
  if (
    typeof value !== "string" ||
    !value.trim() ||
    value.length > max ||
    /[\u0000-\u001f]/.test(value)
  )
    throw new ApplicationError(400, "INVALID_PAYLOAD");
  return value;
}

export function uuid(value: unknown): string {
  const id = text(value, 64);
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id))
    throw new ApplicationError(400, "INVALID_ID");
  return id.toLowerCase();
}

function onlyKeys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some((key) => !allowed.includes(key)))
    throw new ApplicationError(400, "UNKNOWN_FIELD");
}

export function money(value: unknown): MoneyProps {
  const props = object(value);
  onlyKeys(props, ["amount", "currency"]);
  try {
    return Money.from({
      amount: props.amount as string,
      currency: props.currency as string,
    }).toJSON();
  } catch {
    throw new ApplicationError(400, "INVALID_MONEY");
  }
}

export function walletRequest(value: unknown): { playerId: string; initialBalance: MoneyProps } {
  const props = object(value);
  onlyKeys(props, ["playerId", "initialBalance"]);
  return { playerId: uuid(props.playerId), initialBalance: money(props.initialBalance) };
}

export function wagerRequest(value: unknown): WagerRequest {
  const props = object(value);
  onlyKeys(props, [
    "providerId",
    "externalTransactionId",
    "playerId",
    "walletId",
    "roundId",
    "gameId",
    "kind",
    "money",
    "referenceExternalTransactionId",
  ]);
  const providerId = text(props.providerId, 64);
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_.:-]*$/.test(providerId))
    throw new ApplicationError(400, "INVALID_PROVIDER");
  const kind = text(props.kind, 16) as TransactionType;
  if (!Object.values(TransactionType).includes(kind) || kind === TransactionType.OPENING)
    throw new ApplicationError(400, "INVALID_KIND");
  const reference =
    props.referenceExternalTransactionId === undefined
      ? undefined
      : text(props.referenceExternalTransactionId, 128);
  const amount = money(props.money);
  if (
    ([TransactionType.REFUND, TransactionType.ROLLBACK].includes(kind) && !reference) ||
    (kind === TransactionType.BET && amount.amount === "0.00")
  )
    throw new ApplicationError(400, "INVALID_OPERATION");
  return {
    providerId,
    externalTransactionId: text(props.externalTransactionId, 128),
    playerId: uuid(props.playerId),
    walletId: uuid(props.walletId),
    roundId: text(props.roundId, 128),
    gameId: text(props.gameId, 128),
    kind,
    money: amount,
    ...(reference ? { referenceExternalTransactionId: reference } : {}),
  };
}

export function idempotencyKey(value: unknown): string {
  return text(value, 128);
}

export function sqlState(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return undefined;
  const props = error as Record<string, unknown>;
  if (typeof props.code === "string") return props.code;
  return sqlState(props.cause) ?? sqlState(props.previous);
}
