import { KASPA_MAINNET_TOKEN } from '$env/tokens/tokens.kaspa.env';
import type { KaspaNetworkType } from '$kaspa/providers/kaspa-api.providers';
import { getKaspaBalance, getKaspaTransactions } from '$kaspa/providers/kaspa-api.providers';
import type { KaspaCertifiedTransaction } from '$kaspa/stores/kaspa-transactions.store';
import type { KaspaAddress } from '$kaspa/types/address';
import type { KaspaTransaction, KaspaTransactionOutput } from '$kaspa/types/kaspa-api';
import type {
	KaspaPostMessageDataResponseWallet,
	PostMessageDataRequestKaspa
} from '$kaspa/types/kaspa-post-message';
import type { KaspaTransactionUi } from '$kaspa/types/kaspa-transaction';
import { scriptPublicKeyToAddress } from '$kaspa/utils/kaspa-transaction.utils';
import { KASPA_WALLET_TIMER_INTERVAL_MILLIS } from '$lib/constants/app.constants';
import { SchedulerTimer, type Scheduler, type SchedulerJobData } from '$lib/schedulers/scheduler';
import { retryWithDelay } from '$lib/services/rest.services';
import type { OptionIdentity } from '$lib/types/identity';
import type { PostMessageCommon, PostMessageDataResponseError } from '$lib/types/post-message';
import type { CertifiedData } from '$lib/types/store';
import type { Option } from '$lib/types/utils';
import { assertNonNullish, isNullish, jsonReplacer, nonNullish } from '@dfinity/utils';

interface LoadKaspaWalletParams {
	identity: OptionIdentity;
	kaspaNetwork: KaspaNetworkType;
	address: KaspaAddress;
}

interface KaspaWalletStore {
	balance: CertifiedData<Option<bigint>> | undefined;
	transactions: Record<string, KaspaCertifiedTransaction>;
}

interface KaspaWalletData {
	balance: CertifiedData<bigint | null>;
	transactions: KaspaCertifiedTransaction[];
}

/**
 * Map API transaction to UI transaction format
 *
 * Kaspa uses a UTXO model. To determine transaction type:
 * - Receive: The address appears in the outputs with positive amount (receiving new UTXOs)
 * - Send: The address appears in the inputs (spending existing UTXOs)
 *
 * Note: For sends, we report the total output value sent to other addresses,
 * not the amount spent (which would require calculating fees separately)
 */
const mapTransactionToUi = (tx: KaspaTransaction, address: KaspaAddress): KaspaTransactionUi => {
	// Extract HRP from user's address (kaspatest for testnet, kaspa for mainnet)
	const hrp = address.startsWith('kaspatest:') ? 'kaspatest' : 'kaspa';

	// Helper to get address from output (prefer snake_case fields from API)
	const getOutputAddress = (output: KaspaTransactionOutput): KaspaAddress | null => {
		// First try snake_case fields from API
		if (output.script_public_key_address) {
			return output.script_public_key_address;
		}

		// Fallback to verboseData if available
		if (output.verboseData?.scriptPublicKeyAddress) {
			return output.verboseData.scriptPublicKeyAddress;
		}

		// Otherwise decode from scriptPublicKey
		const scriptHex = output.script_public_key || output.scriptPublicKey?.scriptPublicKey;
		if (!scriptHex) {
			return null;
		}

		return scriptPublicKeyToAddress(scriptHex, hrp);
	};

	// Get all output addresses
	const outputAddresses: (KaspaAddress | null)[] = tx.outputs.map(getOutputAddress);

	// Check if this address is receiving (outputs contain the address)
	const isReceiving = outputAddresses.some((outputAddr) => outputAddr === address);

	// Check if this address is sending
	const isSending = !isReceiving && tx.outputs.length > 0;

	// Calculate value and determine transaction type
	let value = 0n;
	let type: 'send' | 'receive';
	let fromAddress: KaspaAddress | undefined;
	let toAddresses: KaspaAddress[] = [];

	if (isReceiving) {
		// Receive: Sum all outputs sent to this address
		type = 'receive';
		for (let i = 0; i < tx.outputs.length; i++) {
			if (outputAddresses[i] === address) {
				value += BigInt(tx.outputs[i].amount);
			}
		}
		// For receive, we don't know the sender from outputs alone
		fromAddress = undefined;
		// All output addresses are potential "to" addresses
		toAddresses = outputAddresses.filter((addr): addr is KaspaAddress => nonNullish(addr));
	} else if (isSending) {
		// Send: Sum all outputs sent to OTHER addresses (excluding change back to self)
		type = 'send';
		for (let i = 0; i < tx.outputs.length; i++) {
			const outputAddress = outputAddresses[i];
			if (nonNullish(outputAddress) && outputAddress !== address) {
				value += BigInt(tx.outputs[i].amount);
			}
		}
		// From is the user's address who initiated the transaction
		fromAddress = address;
		// To addresses are all recipients (excluding self/change)
		toAddresses = outputAddresses.filter(
			(addr): addr is KaspaAddress => nonNullish(addr) && addr !== address
		);
	} else {
		// Edge case: no value transfer, still record it
		type = 'receive';
		fromAddress = undefined;
	}

	return {
		id: tx.transactionId,
		type,
		status: tx.is_accepted ? 'confirmed' : 'pending',
		value,
		from: fromAddress,
		to: toAddresses.length > 0 ? toAddresses : undefined,
		// block_time is already in seconds from the API, store as-is
		timestamp: nonNullish(tx.block_time) ? BigInt(tx.block_time) : undefined,
		blueScore: tx.accepting_block_blue_score
	};
};

export class KaspaWalletScheduler implements Scheduler<PostMessageDataRequestKaspa> {
	#ref: PostMessageCommon['ref'] | undefined;

	private timer = new SchedulerTimer('syncKaspaWalletStatus');

	private store: KaspaWalletStore = {
		balance: undefined,
		transactions: {}
	};

	stop() {
		this.timer.stop();
	}

	protected setRef(data: PostMessageDataRequestKaspa | undefined) {
		this.#ref = nonNullish(data) ? `${KASPA_MAINNET_TOKEN.symbol}-${data.kaspaNetwork}` : undefined;
	}

	async start(data: PostMessageDataRequestKaspa | undefined) {
		this.setRef(data);

		await this.timer.start<PostMessageDataRequestKaspa>({
			interval: KASPA_WALLET_TIMER_INTERVAL_MILLIS,
			job: this.syncWallet,
			data
		});
	}

	async trigger(data: PostMessageDataRequestKaspa | undefined) {
		await this.timer.trigger<PostMessageDataRequestKaspa>({
			job: this.syncWallet,
			data
		});
	}

	private loadBalance = async ({
		address,
		kaspaNetwork: network
	}: LoadKaspaWalletParams): Promise<CertifiedData<bigint | null>> => ({
		data: await getKaspaBalance({ address, network }),
		certified: false
	});

	private loadTransactions = async ({
		kaspaNetwork: network,
		address
	}: LoadKaspaWalletParams): Promise<KaspaCertifiedTransaction[]> => {
		const transactions = await getKaspaTransactions({
			network,
			address,
			limit: 50
		});

		const transactionsUi = transactions.map((transaction) => ({
			data: mapTransactionToUi(transaction, address),
			certified: false
		}));

		return transactionsUi.filter(({ data: { id } }) => isNullish(this.store.transactions[`${id}`]));
	};

	private loadAndSyncWalletData = async ({
		identity,
		data
	}: Required<SchedulerJobData<PostMessageDataRequestKaspa>>) => {
		const {
			address: { data: address },
			...rest
		} = data;

		const [balance, transactions] = await Promise.all([
			this.loadBalance({
				identity,
				address,
				...rest
			}),
			this.loadTransactions({
				identity,
				address,
				...rest
			})
		]);

		this.syncWalletData({ response: { balance, transactions } });
	};

	private syncWallet = async ({
		identity,
		data
	}: SchedulerJobData<PostMessageDataRequestKaspa>) => {
		assertNonNullish(data, 'No data provided to get Kaspa balance.');

		try {
			await retryWithDelay({
				request: async () => await this.loadAndSyncWalletData({ identity, data }),
				maxRetries: 10
			});
		} catch (error: unknown) {
			this.postMessageWalletError({ error });
		}
	};

	private syncWalletData = ({
		response: { balance, transactions }
	}: {
		response: KaspaWalletData;
	}) => {
		if (!this.store.balance?.certified && balance.certified) {
			throw new Error('Balance certification status cannot change from uncertified to certified');
		}

		const newBalance = isNullish(this.store.balance) || this.store.balance.data !== balance.data;
		const newTransactions = transactions.length > 0;

		this.store = {
			...this.store,
			...(newBalance && { balance }),
			...(newTransactions && {
				transactions: {
					...this.store.transactions,
					...transactions.reduce(
						(acc, transaction) => ({
							...acc,
							[transaction.data.id]: transaction
						}),
						{}
					)
				}
			})
		};

		if (!newBalance && !newTransactions) {
			return;
		}

		this.postMessageWallet({
			wallet: {
				balance,
				newTransactions: JSON.stringify(transactions, jsonReplacer)
			}
		});
	};

	private postMessageWallet(data: KaspaPostMessageDataResponseWallet) {
		if (isNullish(this.#ref)) {
			return;
		}

		this.timer.postMsg<KaspaPostMessageDataResponseWallet>({
			ref: this.#ref,
			msg: 'syncKaspaWallet',
			data
		});
	}

	protected postMessageWalletError({ error }: { error: unknown }) {
		if (isNullish(this.#ref)) {
			return;
		}

		this.timer.postMsg<PostMessageDataResponseError>({
			ref: this.#ref,
			msg: 'syncKaspaWalletError',
			data: {
				error
			}
		});
	}
}
