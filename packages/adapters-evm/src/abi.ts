export const payoutExecutorAbi = [
  {
    type: 'function',
    name: 'executePayment',
    stateMutability: 'nonpayable',
    inputs: [
      {
        name: 'payment',
        type: 'tuple',
        components: [
          { name: 'obligationId', type: 'bytes32' },
          { name: 'token', type: 'address' },
          { name: 'recipient', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'manifestDigest', type: 'bytes32' },
        ],
      },
    ],
    outputs: [],
  },
  {
    type: 'function',
    name: 'wasExecuted',
    stateMutability: 'view',
    inputs: [
      { name: 'payer', type: 'address' },
      { name: 'obligationId', type: 'bytes32' },
    ],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'function',
    name: 'isAllowlisted',
    stateMutability: 'view',
    inputs: [{ name: 'token', type: 'address' }],
    outputs: [{ name: '', type: 'bool' }],
  },
  {
    type: 'event',
    name: 'PaymentExecuted',
    inputs: [
      { name: 'payer', type: 'address', indexed: true },
      { name: 'obligationId', type: 'bytes32', indexed: true },
      { name: 'token', type: 'address', indexed: true },
      { name: 'recipient', type: 'address', indexed: false },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'manifestDigest', type: 'bytes32', indexed: false },
    ],
  },
  { type: 'error', name: 'ZeroRecipient', inputs: [] },
  { type: 'error', name: 'ZeroToken', inputs: [] },
  { type: 'error', name: 'ZeroAmount', inputs: [] },
  { type: 'error', name: 'ZeroObligationId', inputs: [] },
  { type: 'error', name: 'TokenNotAllowlisted', inputs: [{ name: 'token', type: 'address' }] },
  {
    type: 'error',
    name: 'AlreadyExecuted',
    inputs: [
      { name: 'payer', type: 'address' },
      { name: 'obligationId', type: 'bytes32' },
    ],
  },
  {
    type: 'error',
    name: 'TransferAmountMismatch',
    inputs: [
      { name: 'expected', type: 'uint256' },
      { name: 'received', type: 'uint256' },
    ],
  },
] as const;

export const erc20Abi = [
  { type: 'function', name: 'decimals', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint8' }] },
  { type: 'function', name: 'symbol', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  { type: 'function', name: 'name', stateMutability: 'view', inputs: [], outputs: [{ type: 'string' }] },
  {
    type: 'function',
    name: 'balanceOf',
    stateMutability: 'view',
    inputs: [{ name: 'account', type: 'address' }],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'allowance',
    stateMutability: 'view',
    inputs: [
      { name: 'owner', type: 'address' },
      { name: 'spender', type: 'address' },
    ],
    outputs: [{ type: 'uint256' }],
  },
  {
    type: 'function',
    name: 'approve',
    stateMutability: 'nonpayable',
    inputs: [
      { name: 'spender', type: 'address' },
      { name: 'amount', type: 'uint256' },
    ],
    outputs: [{ type: 'bool' }],
  },
  {
    type: 'event',
    name: 'Transfer',
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'to', type: 'address', indexed: true },
      { name: 'value', type: 'uint256', indexed: false },
    ],
  },
] as const;
