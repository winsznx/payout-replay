// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Ownable2Step, Ownable} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title PayoutExecutor
/// @notice Non-custodial, payer-initiated ERC-20 payment executor. The caller
/// is always the token source, so nobody can debit someone else's wallet. An
/// obligation ID can execute at most once per payer through this contract.
/// @dev `manifestDigest` is an audit correlation value recorded in the event.
/// It is not proof that anyone approved the manifest.
contract PayoutExecutor is Ownable2Step, ReentrancyGuard {
    using SafeERC20 for IERC20;

    struct Payment {
        bytes32 obligationId;
        address token;
        address recipient;
        uint256 amount;
        bytes32 manifestDigest;
    }

    mapping(address token => bool) public isAllowlisted;
    mapping(address payer => mapping(bytes32 obligationId => bool)) private executed;

    event PaymentExecuted(
        address indexed payer,
        bytes32 indexed obligationId,
        address indexed token,
        address recipient,
        uint256 amount,
        bytes32 manifestDigest
    );
    event TokenAllowlistUpdated(address indexed token, bool allowed);

    error ZeroRecipient();
    error ZeroToken();
    error ZeroAmount();
    error ZeroObligationId();
    error TokenNotAllowlisted(address token);
    error AlreadyExecuted(address payer, bytes32 obligationId);
    error TransferAmountMismatch(uint256 expected, uint256 received);

    constructor(address initialOwner) Ownable(initialOwner) {}

    function setTokenAllowlisted(address token, bool allowed) external onlyOwner {
        if (token == address(0)) revert ZeroToken();
        isAllowlisted[token] = allowed;
        emit TokenAllowlistUpdated(token, allowed);
    }

    function wasExecuted(address payer, bytes32 obligationId) external view returns (bool) {
        return executed[payer][obligationId];
    }

    /// @notice Pays `payment.amount` of `payment.token` from the caller to the
    /// recipient, using an allowance the caller granted to this contract.
    /// @dev Reverts as a whole on any failure; there is no partial success.
    function executePayment(Payment calldata payment) external nonReentrant {
        if (payment.obligationId == bytes32(0)) revert ZeroObligationId();
        if (payment.token == address(0)) revert ZeroToken();
        if (payment.recipient == address(0)) revert ZeroRecipient();
        if (payment.amount == 0) revert ZeroAmount();
        if (!isAllowlisted[payment.token]) revert TokenNotAllowlisted(payment.token);
        if (executed[msg.sender][payment.obligationId]) {
            revert AlreadyExecuted(msg.sender, payment.obligationId);
        }

        executed[msg.sender][payment.obligationId] = true;

        IERC20 token = IERC20(payment.token);
        uint256 balanceBefore = token.balanceOf(payment.recipient);
        token.safeTransferFrom(msg.sender, payment.recipient, payment.amount);
        uint256 received = token.balanceOf(payment.recipient) - balanceBefore;
        // Fee-on-transfer and rebasing tokens are unsupported; fail closed
        // rather than record a nominal amount the recipient never got.
        if (received != payment.amount) revert TransferAmountMismatch(payment.amount, received);

        emit PaymentExecuted(
            msg.sender, payment.obligationId, payment.token, payment.recipient, payment.amount, payment.manifestDigest
        );
    }
}
