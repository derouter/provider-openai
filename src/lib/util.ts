import * as bignumber from "@ethersproject/bignumber";

export const pick = <T extends {}, K extends keyof T>(obj: T, keys: Array<K>) =>
  Object.fromEntries(
    keys.filter((key) => key in obj).map((key) => [key, obj[key]])
  ) as Pick<T, K>;

export const omit = <T extends {}, K extends keyof T>(obj: T, keys: Array<K>) =>
  Object.fromEntries(
    Object.entries(obj).filter(([key]) => !keys.includes(key as K))
  ) as Omit<T, K>;

/**
 * Would panic upon non-exhaustive-ness.
 * @example default: unreachable(case)
 */
export function unreachable(arg: never) {
  return arg;
}

/**
 * An object promised to be resolved in the future.
 *
 * @example
 * const deferred = new Deferred<number>();
 * deferred.promise.then(console.log);
 * deferred.resolve(42);
 */
export class Deferred<T> {
  readonly promise: Promise<T>;
  private _resolve!: (value: T | PromiseLike<T>) => void;
  private _reject!: (reason: any) => void;
  private _resolved = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  get resolved() {
    return this._resolved;
  }

  resolve(value: T | PromiseLike<T>): void {
    this._resolved = true;
    this._resolve(value);
  }

  reject(reason: any): void {
    this._reject(reason);
  }
}

/**
 * @example parseEther("1.0") === BigNumber.from("1000000000000000000")
 */
export function parseEther(value: string): bignumber.BigNumber {
  return bignumber.parseFixed(value, 18);
}

/**
 * @example formatEther(BigNumber.from("1000000000000000000")) === "1.0"
 */
export function formatEther(value: bignumber.BigNumber): string {
  return bignumber.formatFixed(value, 18);
}

/**
 * @example parseWeiToEth("1000000000000000000") === 1.0
 */
export function parseWeiToEth(value: string): number {
  return parseFloat(formatEther(bignumber.BigNumber.from(value)));
}
