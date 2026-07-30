/**
 * Validated, asset-aware amount handling for quest accounting (#504).
 *
 * Replaces parseInt()/Number() + float accumulation on raw action payloads
 * (which silently truncates fractional stroop values and risks precision
 * loss above Number.MAX_SAFE_INTEGER) with a bigint-backed value object
 * that carries its asset identity everywhere it goes, so amounts from
 * different assets can never be summed without the caller explicitly
 * grouping by asset first.
 */

export class InvalidAmountError extends Error {
  constructor(
    message: string,
    public readonly payload: unknown,
  ) {
    super(message);
    this.name = "InvalidAmountError";
  }
}

export class MixedAssetSumError extends Error {
  constructor(public readonly assetCodes: string[]) {
    super(
      `Cannot sum amounts across different assets without an explicit conversion policy: ${assetCodes.join(", ")}`,
    );
    this.name = "MixedAssetSumError";
  }
}

/**
 * A raw integer amount in an asset's smallest unit (e.g. stroops for a
 * 7-decimal Stellar asset), tagged with the asset it belongs to. Never
 * constructed directly — use Amount.fromPayload / Amount.zero.
 */
export class Amount {
  private constructor(
    public readonly raw: bigint,
    public readonly assetCode: string,
    public readonly decimals: number,
  ) {}

  static zero(assetCode: string, decimals: number): Amount {
    return new Amount(0n, assetCode, decimals);
  }

  /**
   * Parses an action payload's amount field into a validated Amount.
   *
   * Rejects (throws InvalidAmountError) rather than silently defaulting to
   * zero when:
   * - `amount` is missing, not a string/number, or not parseable as an integer.
   * - `amount` contains a fractional component (e.g. "12.5") — on-chain
   *   amounts are always integer minor units; a fractional value indicates
   *   either a unit-conversion bug upstream or a malformed/partial payload,
   *   never a legitimate value to round or truncate.
   * - `assetCode` is missing. Callers must supply the pool's configured
   *   asset explicitly (via poolAssetCode) rather than relying on this
   *   function to invent a default — there is no safe universal default
   *   across pools.
   */
  static fromPayload(
    payload: Record<string, unknown> | null | undefined,
    poolAssetCode: string,
    decimals: number,
  ): Amount {
    if (!payload) {
      throw new InvalidAmountError("Missing action payload", payload);
    }

    const rawValue = payload.amount;
    if (typeof rawValue !== "string" && typeof rawValue !== "number") {
      throw new InvalidAmountError(
        `amount must be a string or number, got ${typeof rawValue}`,
        payload,
      );
    }

    const asString = String(rawValue).trim();
    if (asString.length === 0) {
      throw new InvalidAmountError("amount is an empty string", payload);
    }

    // Reject anything that isn't a plain (optionally signed) base-10
    // integer literal — no decimals, no exponents, no whitespace-internal
    // characters, no partial parses (parseInt("12.5abc") silently returns
    // 12; BigInt("12.5") throws, which is what we want here).
    if (!/^-?\d+$/.test(asString)) {
      throw new InvalidAmountError(
        `amount must be an integer minor-unit value with no fractional component, got "${asString}"`,
        payload,
      );
    }

    let raw: bigint;
    try {
      raw = BigInt(asString);
    } catch {
      throw new InvalidAmountError(`amount could not be parsed as a bigint: "${asString}"`, payload);
    }

    if (raw < 0n) {
      throw new InvalidAmountError(`amount must not be negative, got "${asString}"`, payload);
    }

    if (!poolAssetCode) {
      throw new InvalidAmountError(
        "poolAssetCode is required and must be a non-empty string",
        payload,
      );
    }

    return new Amount(raw, poolAssetCode, decimals);
  }

  add(other: Amount): Amount {
    if (other.assetCode !== this.assetCode) {
      throw new MixedAssetSumError([this.assetCode, other.assetCode]);
    }
    return new Amount(this.raw + other.raw, this.assetCode, this.decimals);
  }

  subtract(other: Amount): Amount {
    if (other.assetCode !== this.assetCode) {
      throw new MixedAssetSumError([this.assetCode, other.assetCode]);
    }
    return new Amount(this.raw - other.raw, this.assetCode, this.decimals);
  }

  isPositive(): boolean {
    return this.raw > 0n;
  }

  compare(other: Amount): -1 | 0 | 1 {
    if (other.assetCode !== this.assetCode) {
      throw new MixedAssetSumError([this.assetCode, other.assetCode]);
    }
    if (this.raw < other.raw) return -1;
    if (this.raw > other.raw) return 1;
    return 0;
  }

  /** Human-readable decimal string, e.g. 12345678n @ 7 decimals -> "1.2345678". Formatting only — never used in arithmetic. */
  toDisplayString(): string {
    const negative = this.raw < 0n;
    const abs = negative ? -this.raw : this.raw;
    const s = abs.toString().padStart(this.decimals + 1, "0");
    const whole = s.slice(0, s.length - this.decimals) || "0";
    const frac = this.decimals > 0 ? s.slice(s.length - this.decimals) : "";
    const sign = negative ? "-" : "";
    return frac ? `${sign}${whole}.${frac}` : `${sign}${whole}`;
  }

  toJSON(): { raw: string; assetCode: string; decimals: number } {
    return { raw: this.raw.toString(), assetCode: this.assetCode, decimals: this.decimals };
  }

  /**
   * Sums a list of amounts. Throws MixedAssetSumError if they don't all
   * share the same assetCode — callers must group by (poolId, assetCode)
   * before calling this, never sum across pools/assets implicitly.
   */
  static sum(amounts: Amount[], assetCode: string, decimals: number): Amount {
    return amounts.reduce((acc, a) => acc.add(a), Amount.zero(assetCode, decimals));
  }
}
