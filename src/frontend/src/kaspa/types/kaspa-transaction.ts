import type { KaspaAddress } from '$kaspa/types/address';
import type { kaspaTransactionTypes } from '$lib/schema/transaction.schema';
import type { TransactionId, TransactionType, TransactionUiCommon } from '$lib/types/transaction';

export type KaspaTransactionType = Extract<
	TransactionType,
	(typeof kaspaTransactionTypes.options)[number]
>;

export type KaspaTransactionStatus = 'confirmed' | 'pending';

// Kaspa uses UTXO model like Bitcoin, so transactions can have multiple recipients
// Note: from is optional because Kaspa API doesn't provide sender addresses in transaction inputs
export interface KaspaTransactionUi extends Omit<TransactionUiCommon, 'to' | 'from'> {
	id: TransactionId;
	type: KaspaTransactionType;
	status: KaspaTransactionStatus;
	value?: bigint;
	fee?: bigint;
	blueScore?: number;
	from?: KaspaAddress;
	// Kaspa transaction can have multiple recipients
	to?: KaspaAddress[];
}
