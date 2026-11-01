// Adapted from @rareprotocol/connect examples/target-game (MIT, Copyright 2026 SuperRare).
import type {
  ConnectIntentCreation, SuperRareGameClient, SuperRareConnectClient,
  GameCreditPurchase, GameCreditBalance, ConnectIntent,
} from '@rareprotocol/connect';
import { describeSdkFailure } from './hosted-flow.js';
import { z } from 'zod';
const purchaseRecordSchema = z.object({
  purchase: z.object({
    id: z.string(),
    accountId: z.string(),
    paymentConfigId: z.string(),
    chainId: z.number(),
    address: z.string(),
    treasuryAddress: z.string(),
    // Studio's purchase quote names the payment token `currency` + `tokenAddress` since 2026-10-19 (SDK 0.11); records
    // saved before that carry `usdcAddress` instead. Both load, normalised to the current shape below.
    currency: z.enum(['ETH', 'USDC']).optional(),
    tokenAddress: z.string().nullable().optional(),
    usdcAddress: z.string().optional(),
    packPriceAtomic: z.string(),
    packCredits: z.number(),
    minBlock: z.string(),
    createdAt: z.string(),
    expiresAt: z.string(),
    transactionHash: z.string().nullable(),
    creditedAt: z.string().nullable(),
  }).passthrough(),
  confirmPayment: z.boolean().optional(),
  outcomeUnknown: z.boolean().optional(),
  intentId: z.string().optional(),
  intentStatus: z.string().optional(),
  transactionHash: z.string().optional(),
  credited: z.boolean().optional(),
  claimRefused: z.boolean().optional(),
}).passthrough().transform((record) => {
  const { usdcAddress, ...purchase } = record.purchase;
  const tokenAddress = purchase.tokenAddress !== undefined ? purchase.tokenAddress : (usdcAddress ?? null);
  return { ...record, purchase: { ...purchase, currency: purchase.currency ?? 'USDC', tokenAddress } } as PurchaseRecord;
});
/** A saved purchase record, in either shape (tests and recovery). */
export const parseSavedPurchase = (value: unknown): PurchaseRecord => purchaseRecordSchema.parse(value);
const archivedPurchasesSchema = z.array(z.object({
  record: purchaseRecordSchema,
  archivedAt: z.string(),
}));
const MAINNET_USDC = '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48';
type PackTerms = { currency: 'ETH' | 'USDC'; tokenAddress: string | null; priceAtomic: string; credits: number };
/** The packs the arcade has sold. USDC (2026-10-17 to 2026-10-20) is kept to switch back in one line. */
const PACKS = {
  USDC: { currency: 'USDC', tokenAddress: MAINNET_USDC, priceAtomic: '10000000', credits: 50 },          // 10 USDC (6 decimals)
  ETH: { currency: 'ETH', tokenAddress: null, priceAtomic: '5000000000000000', credits: 50 },             // 0.005 ETH, in wei
} as const satisfies Record<string, PackTerms>;
/**
 * The pack this arcade's credit group sells (deploy/credit-group.json): 50 credits for 0.005 ETH. The single source of
 * truth for the price: the client refuses any quote that differs, and every price shown on the page is derived from it.
 * tests/credits-terms.test.ts keeps these in step with the group's terms.
 */
export const PACK: PackTerms = PACKS.ETH;
export const EXPECTED_PACK_PRICE_ATOMIC = PACK.priceAtomic;
export const EXPECTED_PACK_CREDITS = PACK.credits;
/** The quote is paid in the pack's currency: native ETH (no token address at all), or canonical mainnet USDC. */
export function quoteTokenMatches(quote: { currency?: string; tokenAddress?: string | null }): boolean {
  if (quote.currency !== PACK.currency) return false;
  if (PACK.tokenAddress === null) return quote.tokenAddress === null;
  return typeof quote.tokenAddress === 'string' && quote.tokenAddress.toLowerCase() === PACK.tokenAddress;
}
/** "0.005 ETH" / "10 USDC": the pack price as players read it. */
export function packPriceLabel(): string { return formatPrice(EXPECTED_PACK_PRICE_ATOMIC, PACK.currency).replace(/^\$/, '').replace(/\.00 /, ' '); }
export function packTermsMatch(quote: { packPriceAtomic: string; packCredits: number }): boolean {
  return quote.packPriceAtomic === EXPECTED_PACK_PRICE_ATOMIC && quote.packCredits === EXPECTED_PACK_CREDITS;
}
const STORAGE_VERSION = 'v1';
type PurchaseRecord = {
  purchase: GameCreditPurchase;
  confirmPayment?: boolean;
  outcomeUnknown?: boolean;
  intentId?: string;
  intentStatus?: string;
  transactionHash?: string;
  credited?: boolean;
  /** Studio refused the claim (the transaction does not match the quote): retrying cannot succeed. */
  claimRefused?: boolean;
};
const DEAD_INTENT = ['failed', 'cancelled', 'expired'];
type CreditConfiguration = {
  client: SuperRareConnectClient;
  game: SuperRareGameClient;
  root: HTMLElement;
  storageKey: string;
  changed?: () => void;
  /** The page's buy screen: the panel's Buy buttons open it instead of requesting a quote directly. */
  onBuyRequested?: () => void;
  /** Every status line, also shown on the buy screen; `recovery` asks the page to offer the recovery panel. */
  onStatus?: (message: string, hint?: { recovery?: boolean }) => void;
};
/** Studio's claim refusal when the transaction did not come from the quote's wallet (or does not match it otherwise). */
const QUOTE_MISMATCH = /does not match this payment quote/i;
type ActionButton = (label: string, action: () => void | Promise<void>, className?: string) => HTMLButtonElement;

function text(element: HTMLElement, value: string): void {
  element.textContent = value;
}

/** ETH has 18 decimals ("0.005 ETH"); USDC 6, shown with at least cents so 100000 reads "$0.10 USDC", not "$0.1 USDC". */
export function formatPrice(atomic: string, currency: string = PACK.currency): string {
  if (!/^\d+$/.test(String(atomic))) return 'an amount shown by the wallet';
  const value = BigInt(atomic);
  if (currency === 'ETH') {
    const fraction = String(value % 10n ** 18n).padStart(18, '0').replace(/0+$/, '');
    return `${value / 10n ** 18n}${fraction ? `.${fraction}` : ''} ETH`;
  }
  const whole = value / 1_000_000n;
  const fraction = String(value % 1_000_000n).padStart(6, '0').replace(/0+$/, '').padEnd(2, '0');
  return `$${whole}.${fraction} USDC`;
}

function balanceText(balance: GameCreditBalance): string {
  const plays = `${balance.available} credit${balance.available === 1 ? '' : 's'}`;
  return balance.reserved ? `${plays} · ${balance.reserved} reserved` : plays;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : 'An unexpected error occurred.';
}

export class Credits {
  client: SuperRareConnectClient;
  game: SuperRareGameClient;
  root: HTMLElement;
  storageKey: string;
  changed: () => void;
  onBuyRequested?: () => void;
  onStatus: (message: string, hint?: { recovery?: boolean }) => void;
  balance?: GameCreditBalance;
  record?: PurchaseRecord;
  accountAddress?: string;
  claimPromises = new Map<string, Promise<void>>();
  rendered = false;
  busy = false;
  recoveryBlocked = false;
  balanceLabel!: HTMLParagraphElement;
  statusLabel!: HTMLParagraphElement;
  actions!: HTMLDivElement;
  technical!: HTMLDetailsElement;
  detailsText!: HTMLParagraphElement;
  recoveryActions!: HTMLDivElement;
  historyList!: HTMLOListElement;

  constructor({ client, game, root, storageKey, changed, onBuyRequested, onStatus }: CreditConfiguration) {
    this.client = client;
    this.game = game;
    this.root = root;
    this.storageKey = storageKey;
    this.changed = changed ?? (() => {});
    this.onBuyRequested = onBuyRequested;
    this.onStatus = onStatus ?? (() => {});
  }

  /** A purchase that was started (quote, payment or claim) and has not been credited yet. */
  pendingPurchase(): boolean {
    const record = this.record;
    return Boolean(record && !record.credited && !record.purchase.creditedAt && !this._isDead(record));
  }

  /** A record no money can still arrive through: an unpaid quote that expired, a failed intent, a refused claim. */
  _isDead(record: PurchaseRecord): boolean {
    if (record.claimRefused) return true;
    if (record.intentStatus && DEAD_INTENT.includes(record.intentStatus) && !record.transactionHash) return true;
    return Boolean(record.confirmPayment && !record.intentId && Date.parse(record.purchase.expiresAt) <= Date.now());
  }

  /** Move the current record to the recovery history (kept, never deleted) so a new purchase can start. */
  _archiveCurrent(): boolean {
    const record = this.record;
    if (!record || !this.accountAddress) return true;
    try {
      const historyKey = `${this._stateKey(this.accountAddress)}:history`;
      const serialized = localStorage.getItem(historyKey);
      const history = serialized === null ? [] : archivedPurchasesSchema.parse(JSON.parse(serialized));
      localStorage.setItem(historyKey, JSON.stringify([...history, { record, archivedAt: new Date().toISOString() }]));
      localStorage.removeItem(this._stateKey(this.accountAddress));
      this.record = undefined;
      this._showDetails();
      return true;
    } catch (error) {
      this._say(`Could not keep the previous purchase in recovery, so it was not replaced: ${errorMessage(error)}`);
      return false;
    }
  }

  /** The buy screen's one click: request a quote, check it against the advertised pack, then open the payment. */
  async buyNow(): Promise<void> {
    const record = this.record;
    if (record && !record.credited && !record.purchase.creditedAt) {
      if (this._isDead(record)) {
        if (!this._archiveCurrent()) return;           // kept in recovery; no money can still arrive through it
      } else if (record.confirmPayment) {
        await this._pay();                             // a valid quote that was never paid: pay it (one click, no network first)
        return;
      } else {
        this._say('A purchase is already in progress. Finish or recover it from the wallet menu before paying again.', { recovery: true });
        return;
      }
    }
    if (await this._createQuote()) await this._pay();
  }

  /** Open the recovery details ("purchase help" in the wallet). */
  openRecovery(): void {
    if (!this.rendered) return;
    this.technical.open = true;
  }

  render(): this {
    if (this.rendered) return this;
    this.rendered = true;
    this.root.replaceChildren();

    this.balanceLabel = document.createElement('p');
    this.balanceLabel.setAttribute('aria-live', 'polite');
    text(this.balanceLabel, 'Credits not loaded yet');
    this.root.append(this.balanceLabel);

    this.statusLabel = document.createElement('p');
    this.statusLabel.setAttribute('role', 'status');
    this.statusLabel.setAttribute('aria-live', 'polite');
    this.root.append(this.statusLabel);

    this.actions = document.createElement('div');
    this.actions.className = 'credit-actions';
    this.root.append(this.actions);

    const historyTitle = document.createElement('h3');
    historyTitle.className = 'panel-subtitle';
    text(historyTitle, 'Purchases on this device');
    this.historyList = document.createElement('ol');
    this.historyList.className = 'purchase-history';
    this.root.append(historyTitle, this.historyList);

    this.technical = document.createElement('details');
    const summary = document.createElement('summary');
    text(summary, 'Recovery details');
    this.technical.append(summary);
    this.detailsText = document.createElement('p');
    this.detailsText.className = 'technical-details';
    this.technical.append(this.detailsText);
    this.recoveryActions = document.createElement('div');
    this.recoveryActions.className = 'credit-actions';
    this.technical.append(this.recoveryActions);
    this.root.append(this.technical);
    this.technical.addEventListener('toggle', () => {
      if (this.technical.open) void this.refresh();
    });
    void this.refresh();
    return this;
  }

  _authorization(): { address: string } | undefined {
    const authorization = this.game.getAuthorization();
    if (!authorization?.address || authorization.address.toLowerCase() !== this.client.auth.getSession()?.address.toLowerCase()) return undefined;
    return { address: authorization.address.toLowerCase() };
  }

  _stateKey(address: string | undefined): string {
    return `${this.storageKey}:${STORAGE_VERSION}:${address}`;
  }

  _loadRecord(address: string): PurchaseRecord | undefined {
    try {
      const serialized = localStorage.getItem(this._stateKey(address));
      const record = serialized === null ? undefined : purchaseRecordSchema.parse(JSON.parse(serialized));
      this.recoveryBlocked = false;
      return record;
    } catch {
      this.recoveryBlocked = true;
      return undefined;
    }
  }

  _saveRecord(record: PurchaseRecord): void {
    // Preserve evidence under its original wallet, even if auth changes in flight.
    const owner = record.purchase.address.toLowerCase();
    localStorage.setItem(this._stateKey(owner), JSON.stringify(record));
    this._assertAccount(owner);
    this.record = record;
    this._showDetails();
  }

  _assertAccount(address: string): void {
    if (this._authorization()?.address !== address || this.accountAddress !== address) {
      throw new Error('Wallet changed. The original purchase remains saved under its owning wallet.');
    }
  }

  _showHistory(): void {
    const rows: { record: PurchaseRecord; archived: boolean }[] = [];
    if (this.record) rows.push({ record: this.record, archived: false });
    if (this.accountAddress) {
      try {
        const serialized = localStorage.getItem(`${this._stateKey(this.accountAddress)}:history`);
        const history = serialized === null ? [] : archivedPurchasesSchema.parse(JSON.parse(serialized));
        for (const { record } of [...history].reverse()) rows.push({ record: record as PurchaseRecord, archived: true });
      } catch { /* the recovery panel reports unreadable records */ }
    }
    this.historyList.replaceChildren(...rows.map(({ record, archived }) => {
      const item = document.createElement('li');
      const purchase = record.purchase;
      const credited = Boolean(record.credited || purchase.creditedAt);
      const hash = record.transactionHash ?? purchase.transactionHash ?? undefined;
      const state = credited ? 'credited' : hash ? 'paid · not claimed' : record.intentId || record.outcomeUnknown ? 'payment pending' : record.confirmPayment ? 'quote, not paid' : 'pending';
      text(item, `${purchase.packCredits} credits · ${formatPrice(purchase.packPriceAtomic, purchase.currency)} · ${state}${archived ? ' · archived' : ''} · ${purchase.createdAt.slice(0, 10)} `);
      if (hash && /^0x[0-9a-fA-F]{64}$/.test(hash)) {
        const link = document.createElement('a');
        link.href = `https://etherscan.io/tx/${hash}`;
        link.target = '_blank'; link.rel = 'noopener';
        text(link, `tx ${hash.slice(0, 8)}…${hash.slice(-4)}`);
        item.append(link);
      }
      return item;
    }));
    if (!rows.length) {
      const item = document.createElement('li');
      item.className = 'empty';
      // only this browser's records: a purchase made elsewhere, or credits given, are in the balance, not here
      text(item, this.accountAddress ? 'No purchase recorded on this device. Credits bought elsewhere or given show in your balance.' : 'Sign in to see your purchases.');
      this.historyList.append(item);
    }
  }

  _showDetails(): void {
    this._showHistory();
    this.recoveryActions.replaceChildren();
    this._showArchivedPurchases();
    if (!this.record) {
      text(this.detailsText, this.accountAddress
        ? 'No purchase is in progress for this game account.'
        : 'Saved purchases remain isolated per game account. Reauthorize the same account to resume or reconcile them.');
      return;
    }
    const purchase = this.record.purchase;
    text(this.detailsText, [
      `Purchase ID: ${purchase.id}`,
      `Quote expires: ${purchase.expiresAt}`,
      this.record.intentId ? `Connect intent: ${this.record.intentId}` : '',
      this.record.transactionHash ? `Transaction: ${this.record.transactionHash}` : '',
      this.record.outcomeUnknown && !this.record.intentId
        ? 'Payment outcome is unknown; starting over will not cancel any wallet transaction.'
        : '',
    ].filter(Boolean).join('\n'));
    if (!this.record.transactionHash && !this.record.credited && !this.record.purchase.creditedAt) {
      this._addButton(this.recoveryActions, 'Claim with existing transaction hash…', () => this._enterTransaction());
    }
  }

  _showArchivedPurchases(): void {
    if (!this.accountAddress) return;
    try {
      const serialized = localStorage.getItem(`${this._stateKey(this.accountAddress)}:history`);
      if (serialized === null) return;
      const history = archivedPurchasesSchema.parse(JSON.parse(serialized));
      history.forEach(({ record }, index) => {
        this._addButton(
          this.recoveryActions,
          `Resume saved purchase ${index + 1} · ${record.purchase.packCredits} credits`,
          () => this._restoreArchivedPurchase(index),
        );
      });
    } catch {
      this._say('Saved advanced recovery records could not be read; the current purchase is unchanged.');
    }
  }

  _restoreArchivedPurchase(index: number): void {
    if (this.recoveryBlocked || !this.accountAddress || this.busy) return;
    const historyKey = `${this._stateKey(this.accountAddress)}:history`;
    try {
      const serialized = localStorage.getItem(historyKey);
      if (serialized === null) return;
      const history = archivedPurchasesSchema.parse(JSON.parse(serialized));
      const selected = history[index];
      if (!selected) return;
      const current = this.record;
      const remaining = history.filter((_, historyIndex) => historyIndex !== index);
      localStorage.setItem(historyKey, JSON.stringify([
        ...remaining,
        ...(current ? [{ record: current, archivedAt: new Date().toISOString() }] : []),
      ]));
      this._saveRecord(selected.record);
      this._say('Saved purchase restored. Continue it to reconcile, or use advanced recovery to claim with a transaction hash.');
      this._renderActions();
    } catch (error) {
      this._say(`Could not restore the saved purchase: ${errorMessage(error)}`);
    }
  }

  _say(message: string, hint?: { recovery?: boolean }): void {
    text(this.statusLabel, message);
    this.onStatus(message, hint);
  }

  _addButton(actions: HTMLElement, label: string, action: () => void | Promise<void>, className = ''): HTMLButtonElement {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = className;
    text(button, label);
    button.disabled = this.busy;
    button.addEventListener('click', () => void action());
    actions.append(button);
    return button;
  }

  _renderActions(): void {
    this._showDetails();
    this.actions.replaceChildren();
    const addButton: ActionButton = (label, action, className = '') => this._addButton(this.actions, label, action, className);

    if (this.recoveryBlocked) {
      this.recoveryActions.replaceChildren();
      this._say('Saved purchase recovery could not be read. Purchases are blocked to avoid a duplicate payment. Restore browser storage and retry; do not clear existing records.');
      addButton('Retry saved purchase recovery', () => this.refresh());
      return;
    }
    if (!this.accountAddress) return;
    const record = this.record;
    const buy = (): void => { if (this.onBuyRequested) this.onBuyRequested(); else void this._createQuote(); };
    // the plain "Buy credits" (nothing to recover) is hidden where the page has its own buy button (.buy-plain)
    if (record?.credited || record?.purchase?.creditedAt) {
      addButton('Buy credits', buy, 'primary buy-plain');
      return;
    }
    if (!record) {
      addButton('Buy credits', buy, 'primary buy-plain');
      return;
    }

    if (record.claimRefused) {
      addButton('Buy credits', buy, 'primary');
      addButton('Retry this claim', () => this._continuePurchase());
      return;
    }
    if (record.transactionHash) {
      addButton('Continue purchase', () => this._continuePurchase(), 'primary');
      return;
    }

    if (record.intentId || record.outcomeUnknown) {
      addButton('Continue purchase', () => this._continuePurchase(), 'primary');
      addButton('Start over with a fresh quote', () => this._startOver());
      return;
    }

    if (record.confirmPayment) {
      addButton(`Confirm ${record.purchase.packCredits} credits · ${formatPrice(record.purchase.packPriceAtomic, record.purchase.currency)}`, () => this._pay(), 'primary');
      addButton('Cancel quote', () => this._discardQuote());
      return;
    }

    addButton('Continue purchase', () => this._continuePurchase(), 'primary');
  }
  async refresh() {
    if (!this.rendered) return;
    const authorization = this._authorization();
    if (!authorization) {
      this.accountAddress = undefined;
      this.balance = undefined;
      text(this.balanceLabel, 'Sign in to see your credits.');
      this.record = undefined;
      this._showDetails();
      this._renderActions();
      return;
    }

    this.accountAddress = authorization.address;
    this.record = this._loadRecord(this.accountAddress);
    this._showDetails();
    this._renderActions();
    try {
      const balance = await this.game.credits.getBalance();
      const currentAuthorization = this._authorization();
      if (currentAuthorization?.address !== authorization.address) {
        this.balance = undefined;
        text(this.balanceLabel, currentAuthorization
          ? 'Loading your credits…'
          : 'Sign in to see your credits.');
        this.accountAddress = currentAuthorization?.address;
        this.record = currentAuthorization ? this._loadRecord(currentAuthorization.address) : undefined;
        this._say(currentAuthorization
          ? 'Game account changed while loading. Showing only the newly authorized account; saved purchases remain isolated per account.'
          : 'Game authorization expired while loading. Saved purchase records remain preserved per account; authorize the game again to resume.');
        this._showDetails();
        this._renderActions();
        this.changed();
        if (currentAuthorization) void this.refresh();
        return;
      }
      this.balance = balance;
      text(this.balanceLabel, balanceText(balance));
      if (this.record) {
        if (this.record.transactionHash && !this.record.credited && !this.record.intentId) {
          await this._claim(this.record.transactionHash);
        }
      }
      this._renderActions();
    } catch (error) {
      const currentAuthorization = this._authorization();
      this.balance = undefined;
      text(this.balanceLabel, currentAuthorization
        ? 'Credits could not be loaded.'
        : 'Sign in to see your credits.');
      if (currentAuthorization?.address !== authorization.address) {
        this.accountAddress = currentAuthorization?.address;
        this.record = currentAuthorization ? this._loadRecord(currentAuthorization.address) : undefined;
        this._say(currentAuthorization
          ? 'Game account changed while loading. Showing only the newly authorized account; saved purchases remain isolated per account.'
          : `Could not load credit balance (${describeSdkFailure(error)}); game authorization is no longer available. Saved purchase records remain preserved per account.`);
        this._showDetails();
        this._renderActions();
        this.changed();
        if (currentAuthorization) void this.refresh();
        return;
      }
      this._say(`Could not load credit balance (${describeSdkFailure(error)}). The current authorization is preserved; retry the balance request.`);
    }
  }

  async _createQuote(): Promise<boolean> {
    if (this.recoveryBlocked || this.busy || !this._authorization()) return false;
    let created = false;
    this.busy = true;
    this._renderActions();
    this._say('Loading a purchase quote…');
    try {
      const quote = await this.game.credits.createPurchase();
      const authorization = this._authorization();
      if (!authorization) throw new Error('Connect a game wallet before buying credits.');
      if (quote.chainId !== 1) throw new Error('This example only accepts Ethereum mainnet credit quotes.');
      if (!packTermsMatch(quote)) {
        throw new Error(`This arcade requires ${formatPrice(EXPECTED_PACK_PRICE_ATOMIC)} for ${EXPECTED_PACK_CREDITS} credits, but the quote is ${formatPrice(quote.packPriceAtomic, quote.currency)} for ${quote.packCredits} credits. Ask the organizer to correct the payment configuration.`);
      }
      if (!quoteTokenMatches(quote)) {
        throw new Error(`The credit quote is not paid in ${PACK.currency === 'ETH' ? 'native ETH' : 'Ethereum mainnet USDC'}, as this arcade's pack is. No payment was started.`);
      }
      if (quote.address.toLowerCase() !== authorization.address) {
        throw new Error('This quote belongs to a different wallet. Refresh your game connection and try again.');
      }
      this.accountAddress = authorization.address;
      const record = { purchase: quote, confirmPayment: true, outcomeUnknown: false };
      this._saveRecord(record);
      this._say(`Quote ready: ${quote.packCredits} credits for ${formatPrice(quote.packPriceAtomic)}, paid from ${authorization.address}.`);
      created = true;
    } catch (error) {
      this._say(`Could not create a safe purchase quote: ${errorMessage(error)} You can try again.`);
    } finally {
      this.busy = false;
      this._renderActions();
    }
    return created;
  }

  _startOver(): void {
    const record = this.record;
    if (this.recoveryBlocked || !record || record.transactionHash || !this.accountAddress) return;
    if (!window.confirm(
      'Start over and request a fresh quote? This will not cancel any wallet transaction already submitted. Keep the old transaction details if payment may have completed.',
    )) return;
    try {
      const historyKey = `${this._stateKey(this.accountAddress)}:history`;
      const serializedHistory = localStorage.getItem(historyKey);
      const history = serializedHistory === null ? [] : archivedPurchasesSchema.parse(JSON.parse(serializedHistory));
      localStorage.setItem(historyKey, JSON.stringify([...history, { record, archivedAt: new Date().toISOString() }]));
      localStorage.removeItem(this._stateKey(this.accountAddress));
      this.record = undefined;
      this._showDetails();
      this._say('Previous purchase saved in advanced recovery. Fresh quote requested; no new payment was submitted.');
      void this._createQuote();
    } catch (error) {
      this._say(`Could not preserve the previous purchase, so it was not replaced: ${errorMessage(error)}`);
    }
    this._renderActions();
  }

  _discardQuote(): void {
    if (this.recoveryBlocked || !this.record?.confirmPayment || !this.accountAddress) return;
    try {
      localStorage.removeItem(this._stateKey(this.accountAddress));
      this.record = undefined;
      this._showDetails();
      this._say('Quote cancelled. No payment was requested.');
    } catch (error) {
      this._say(`Could not cancel this quote: ${errorMessage(error)}`);
    }
    this._renderActions();
  }

  async _pay() {
    const authorization = this._authorization();
    const record = this.record;
    if (this.recoveryBlocked || this.busy || !authorization || !record?.confirmPayment || authorization.address !== this.accountAddress) return;
    const quote = record.purchase;
    if (Date.parse(quote.expiresAt) <= Date.now()) {
      this._say('This quote expired before payment. Cancel it and request a fresh quote; no transfer was started.');
      return;
    }
    if (quote.chainId !== 1 || !packTermsMatch(quote) || !quoteTokenMatches(quote) || quote.address.toLowerCase() !== authorization.address) {
      this._say('This quote no longer matches the connected mainnet wallet. No payment was started.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      // Keep the exact quote and an ambiguous-outcome marker durable before the SDK opens hosted checkout.
      const pending = { ...record, confirmPayment: false, outcomeUnknown: true };
      this._saveRecord(pending);
      this._say('Opening SuperRare Connect checkout. No transfer is submitted until your wallet asks for explicit approval.');
      const intent = await this.client.actions.transfer({
        chainId: 1,
        to: quote.treasuryAddress,
        currency: PACK.currency,                                // the quote's own currency, checked just above
        amount: quote.packPriceAtomic,                          // wei for ETH, 6-decimal units for USDC
        beforeOpen: (intent: ConnectIntentCreation) => this._saveRecord({
          ...pending,
          intentId: intent.intentId,
          outcomeUnknown: false,
        }),
      });
      const withIntent = { ...pending, intentId: intent.intentId, outcomeUnknown: false };
      this._saveRecord(withIntent);
      this._say('Payment request opened. Continue purchase to check its status; a grant is claimed only after a transaction hash is known.');
    } catch (error) {
      const saved = this.accountAddress ? this._loadRecord(this.accountAddress) : undefined;
      if (saved && saved.purchase.id === quote.id && !saved.intentId) {
        // No intent was handed over (the window was blocked or could not open): nobody could approve a transfer.
        this._saveRecord({ ...saved, confirmPayment: true, outcomeUnknown: false });
        this._say(`The payment window did not open (${errorMessage(error)}). Nothing was sent. Press Pay again.`);
      } else {
        this._say(`The payment result is not confirmed (${errorMessage(error)}). Do not start another transfer. Continue purchase to check again, or enter the transaction hash if your wallet completed it.`);
      }
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }

  async _continuePurchase() {
    if (this.recoveryBlocked || this.busy || !this.record) return;
    const authorization = this._authorization();
    if (!authorization) return;
    if (authorization.address !== this.accountAddress) {
      this._say('This purchase belongs to another wallet. Reconnect that wallet to continue; its record is kept separately.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      await this._reconcilePurchase();
      this._assertAccount(authorization.address);
      if (this.record?.intentId) {
        const intent = await this.client.actions.getStatus({ intentId: this.record.intentId });
        this._assertAccount(authorization.address);
        const hash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
        this._saveRecord({
          ...this.record,
          ...(hash ? { transactionHash: hash } : {}),
          intentStatus: intent.status,
          outcomeUnknown: false,
        });
        if (intent.status === 'completed' && hash) {
          await this._claim(hash);
        } else if (['failed', 'cancelled', 'expired'].includes(intent.status)) {
          this._say(`Payment ${intent.status}; no completed transfer was confirmed. You may start over with a fresh quote, or keep this purchase to reconcile later.`);
        } else if (intent.status === 'completed') {
          this._say('Connect completed the action but returned no transaction hash. You may start over with a fresh quote; the existing purchase stays available in advanced recovery.');
        } else {
          this._say(`Payment is ${intent.status}. You may start over with a fresh quote, or keep this purchase to continue later.`);
        }
      } else if (this.record?.transactionHash) {
        await this._claim(this.record.transactionHash);
      } else {
        this._say('The payment outcome is unknown and no intent ID was saved. Start over with a fresh quote if you do not want to wait. If payment completed, resume this saved purchase and claim it with the transaction hash under advanced recovery.');
      }
    } catch (error) {
      this._say(`Purchase status could not be confirmed: ${errorMessage(error)} The same purchase is saved; retry Continue purchase.`);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }

  async _reconcilePurchase() {
    if (!this.record) return;
    const saved = this.record;
    try {
      const purchase = await this.game.credits.getPurchase(saved.purchase.id);
      if (purchase.address.toLowerCase() !== this.accountAddress) {
        this._say('The saved purchase belongs to another wallet. Reconnect that wallet to continue.');
        return;
      }
      const latest = this._loadRecord(saved.purchase.address.toLowerCase()) ?? saved;
      const transactionHash = purchase.transactionHash || latest.transactionHash;
      this._saveRecord({ ...latest, purchase, transactionHash: transactionHash || undefined, credited: Boolean(purchase.creditedAt), outcomeUnknown: transactionHash ? false : latest.outcomeUnknown });
      if (purchase.creditedAt) {
        this._say('Credits received. Balance refreshed.');
        this.balance = await this.game.credits.getBalance();
        this._assertAccount(saved.purchase.address.toLowerCase());
        text(this.balanceLabel, balanceText(this.balance));
        this._saveRecord({ ...latest, purchase, credited: true });
        this.changed();
      }
    } catch (error) {
      // Keep local transfer evidence; absence of a server response is not proof of failure.
      if (saved.transactionHash) throw error;
    }
  }

  _claim(transactionHash: string): Promise<void> {
    if (!this.record) return Promise.resolve();
    const key = `${this.record.purchase.id}:${transactionHash.toLowerCase()}`;
    const existing = this.claimPromises.get(key);
    if (existing) return existing;
    const pending = this._claimOnce(transactionHash).finally(() => this.claimPromises.delete(key));
    this.claimPromises.set(key, pending);
    return pending;
  }

  async _claimOnce(transactionHash: string): Promise<void> {
    const record = this.record;
    if (!record) return;
    let intentStatus = record.intentStatus;
    let claimHash = record.transactionHash || transactionHash;
    try {
      if (record.intentId) {
        const intent = await this.client.actions.getStatus({ intentId: record.intentId });
        const completedHash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
        if (intent.status !== 'completed') {
          this._saveRecord({
            ...record,
            transactionHash: claimHash,
            intentStatus: intent.status,
          });
          this._say(`Transaction hash saved. The hosted transfer is ${intent.status}, not completed; continue this purchase to reconcile its status before claiming credits.`);
          return;
        }
        if (!completedHash || !/^0x[0-9a-fA-F]{64}$/.test(completedHash)) {
          throw new Error('Connect reported completion without a valid transaction hash.');
        }
        if (record.transactionHash
          && record.transactionHash.toLowerCase() !== completedHash.toLowerCase()) {
          throw new Error('Connect reported a different transaction hash; the saved purchase hash was not replaced.');
        }
        claimHash = completedHash;
        intentStatus = intent.status;
      }
      this._saveRecord({
        ...record,
        transactionHash: claimHash,
        ...(intentStatus ? { intentStatus } : {}),
        outcomeUnknown: false,
      });
      const result = await this.game.credits.claimPurchase({ purchaseId: record.purchase.id, transactionHash: claimHash });
      const latest = this._loadRecord(record.purchase.address.toLowerCase()) ?? record;
      this._saveRecord({ ...latest, purchase: result.purchase, credited: Boolean(result.purchase.creditedAt), transactionHash: claimHash });
      this.balance = result.balance;
      text(this.balanceLabel, balanceText(result.balance));
      this._say(result.purchase.creditedAt ? 'Credits received. You can continue playing.' : 'Transaction recorded; credit confirmation is pending. Continue purchase later to check again.');
      this.changed();
    } catch (error) {
      if (QUOTE_MISMATCH.test(errorMessage(error))) {
        const latest = this._loadRecord(record.purchase.address.toLowerCase()) ?? record;
        try { this._saveRecord({ ...latest, transactionHash: claimHash, claimRefused: true }); } catch { /* wallet changed: kept under its owner */ }
        this._say(`This payment cannot be claimed automatically: it does not match the quote, usually because it was paid from a wallet other than ${record.purchase.address}. Open purchase recovery.`, { recovery: true });
      } else {
        this._say(`Transaction is saved, but claiming could not be confirmed: ${errorMessage(error)} Continue purchase retries the same transaction safely.`);
      }
    }
    this._renderActions();
  }

  onIntentSettled(intent: ConnectIntent): void {
    const record = this.record;
    if (!record?.intentId || intent?.intentId !== record.intentId
      || this._authorization()?.address !== this.accountAddress) return;
    const transactionHash = intent.result?.transactionHash ?? intent.result?.approvalTxHash;
    const validHash = transactionHash && /^0x[0-9a-fA-F]{64}$/.test(transactionHash)
      ? transactionHash
      : undefined;
    const definitivelyFailed = ['failed', 'cancelled', 'expired'].includes(intent.status);
    const saved = {
      ...record,
      ...(validHash ? { transactionHash: validHash } : {}),
      intentStatus: intent.status,
      outcomeUnknown: definitivelyFailed ? false : record.outcomeUnknown,
    };
    this._saveRecord(saved);
    if (intent.status === 'completed' && validHash) {
      void this._claim(validHash);
      return;
    }
    this._say(definitivelyFailed
      ? `Payment ${intent.status}; no completed transfer was confirmed. Check your wallet and keep this purchase before requesting anything new.`
      : intent.status === 'completed'
        ? 'Connect completed the action but returned no valid transaction hash. The purchase remains saved; do not start another transfer.'
        : `Payment status is ${intent.status}. Continue this same purchase later; do not request another transfer.`);
    this._renderActions();
  }

  async _enterTransaction() {
    const authorization = this._authorization();
    if (this.recoveryBlocked || !this.record || authorization?.address !== this.accountAddress) return;
    const hash = window.prompt('Enter the Ethereum transaction hash for this saved purchase. Do not enter a different transaction.');
    if (hash === null) return;
    const normalized = hash.trim();
    if (!/^0x[0-9a-fA-F]{64}$/.test(normalized)) {
      this._say('That does not look like a transaction hash. The saved purchase was not changed.');
      return;
    }
    if (this.record.transactionHash && this.record.transactionHash.toLowerCase() !== normalized.toLowerCase()) {
      this._say('A transaction hash is already saved for this purchase. It cannot be replaced here.');
      return;
    }
    this.busy = true;
    this._renderActions();
    try {
      this._saveRecord({ ...this.record, transactionHash: normalized, outcomeUnknown: false });
      await this._claim(normalized);
    } finally {
      this.busy = false;
      this._renderActions();
    }
  }
}
