// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20Errors} from "@openzeppelin/contracts/interfaces/draft-IERC6093.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

import {PayoutExecutor} from "../src/PayoutExecutor.sol";
import {TestToken} from "../src/TestToken.sol";

contract FeeOnTransferToken is ERC20 {
    constructor() ERC20("Fee", "FEE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function _update(address from, address to, uint256 value) internal override {
        if (from != address(0) && to != address(0)) {
            uint256 fee = value / 100;
            super._update(from, address(0xFEE), fee);
            super._update(from, to, value - fee);
        } else {
            super._update(from, to, value);
        }
    }
}

/// Re-enters the executor from inside transferFrom.
contract ReentrantToken is ERC20 {
    PayoutExecutor public executor;
    bytes32 public reentryId;

    constructor() ERC20("Re", "RE") {}

    function arm(PayoutExecutor executor_, bytes32 reentryId_) external {
        executor = executor_;
        reentryId = reentryId_;
    }

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address from, address to, uint256 value) public override returns (bool) {
        if (address(executor) != address(0)) {
            executor.executePayment(
                PayoutExecutor.Payment({
                    obligationId: reentryId, token: address(this), recipient: to, amount: value, manifestDigest: bytes32(0)
                })
            );
        }
        return super.transferFrom(from, to, value);
    }
}

/// Returns false instead of reverting, which SafeERC20 must reject.
contract FalseReturningToken is ERC20 {
    constructor() ERC20("False", "FALSE") {}

    function mint(address to, uint256 amount) external {
        _mint(to, amount);
    }

    function transferFrom(address, address, uint256) public pure override returns (bool) {
        return false;
    }
}

contract PayoutExecutorTest is Test {
    event PaymentExecuted(
        address indexed payer,
        bytes32 indexed obligationId,
        address indexed token,
        address recipient,
        uint256 amount,
        bytes32 manifestDigest
    );

    PayoutExecutor internal executor;
    TestToken internal token;

    address internal owner = makeAddr("owner");
    address internal payer = makeAddr("payer");
    address internal otherPayer = makeAddr("otherPayer");
    address internal recipient = makeAddr("recipient");
    bytes32 internal constant ID = keccak256("obligation-1");
    bytes32 internal constant DIGEST = keccak256("manifest");

    function setUp() public {
        executor = new PayoutExecutor(owner);
        token = new TestToken(owner);
        vm.startPrank(owner);
        executor.setTokenAllowlisted(address(token), true);
        token.mint(payer, 1_000e6);
        token.mint(otherPayer, 1_000e6);
        vm.stopPrank();
    }

    function _payment(bytes32 id, uint256 amount) internal view returns (PayoutExecutor.Payment memory) {
        return PayoutExecutor.Payment({
            obligationId: id, token: address(token), recipient: recipient, amount: amount, manifestDigest: DIGEST
        });
    }

    function _approveAndPay(address from, bytes32 id, uint256 amount) internal {
        vm.startPrank(from);
        token.approve(address(executor), amount);
        executor.executePayment(_payment(id, amount));
        vm.stopPrank();
    }

    function test_paysExactAmountFromCaller() public {
        _approveAndPay(payer, ID, 100e6);
        assertEq(token.balanceOf(recipient), 100e6);
        assertEq(token.balanceOf(payer), 900e6);
        assertTrue(executor.wasExecuted(payer, ID));
        assertEq(token.allowance(payer, address(executor)), 0);
    }

    function test_emitsPaymentExecutedWithAllFields() public {
        vm.startPrank(payer);
        token.approve(address(executor), 100e6);
        vm.expectEmit(true, true, true, true, address(executor));
        emit PaymentExecuted(payer, ID, address(token), recipient, 100e6, DIGEST);
        executor.executePayment(_payment(ID, 100e6));
        vm.stopPrank();
    }

    function test_rejectsDuplicateObligationFromSamePayer() public {
        _approveAndPay(payer, ID, 100e6);
        vm.startPrank(payer);
        token.approve(address(executor), 100e6);
        vm.expectRevert(abi.encodeWithSelector(PayoutExecutor.AlreadyExecuted.selector, payer, ID));
        executor.executePayment(_payment(ID, 100e6));
        vm.stopPrank();
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_sameIdFromDifferentPayersIsIndependent() public {
        _approveAndPay(payer, ID, 100e6);
        _approveAndPay(otherPayer, ID, 100e6);
        assertEq(token.balanceOf(recipient), 200e6);
    }

    function test_twoSameAmountObligationsWithDifferentIdsBothPay() public {
        _approveAndPay(payer, ID, 50e6);
        _approveAndPay(payer, keccak256("obligation-2"), 50e6);
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_rejectsZeroAmount() public {
        vm.prank(payer);
        vm.expectRevert(PayoutExecutor.ZeroAmount.selector);
        executor.executePayment(_payment(ID, 0));
    }

    function test_rejectsZeroRecipient() public {
        PayoutExecutor.Payment memory payment = _payment(ID, 1);
        payment.recipient = address(0);
        vm.prank(payer);
        vm.expectRevert(PayoutExecutor.ZeroRecipient.selector);
        executor.executePayment(payment);
    }

    function test_rejectsZeroToken() public {
        PayoutExecutor.Payment memory payment = _payment(ID, 1);
        payment.token = address(0);
        vm.prank(payer);
        vm.expectRevert(PayoutExecutor.ZeroToken.selector);
        executor.executePayment(payment);
    }

    function test_rejectsZeroObligationId() public {
        vm.prank(payer);
        vm.expectRevert(PayoutExecutor.ZeroObligationId.selector);
        executor.executePayment(_payment(bytes32(0), 1));
    }

    function test_rejectsUnlistedToken() public {
        TestToken unlisted = new TestToken(owner);
        PayoutExecutor.Payment memory payment = _payment(ID, 1);
        payment.token = address(unlisted);
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(PayoutExecutor.TokenNotAllowlisted.selector, address(unlisted)));
        executor.executePayment(payment);
    }

    function test_insufficientAllowanceRevertsAndLeavesIdUnused() public {
        vm.startPrank(payer);
        token.approve(address(executor), 10e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(executor), 10e6, 100e6)
        );
        executor.executePayment(_payment(ID, 100e6));
        vm.stopPrank();
        assertFalse(executor.wasExecuted(payer, ID));
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_insufficientBalanceReverts() public {
        vm.startPrank(payer);
        token.approve(address(executor), 2_000e6);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientBalance.selector, payer, 1_000e6, 2_000e6)
        );
        executor.executePayment(_payment(ID, 2_000e6));
        vm.stopPrank();
        assertFalse(executor.wasExecuted(payer, ID));
    }

    function test_correctionAfterRevertPaysExactlyOnce() public {
        vm.prank(payer);
        vm.expectRevert();
        executor.executePayment(_payment(ID, 100e6));
        _approveAndPay(payer, ID, 100e6);
        assertEq(token.balanceOf(recipient), 100e6);
    }

    function test_cannotDebitAnotherPayersAllowance() public {
        vm.prank(payer);
        token.approve(address(executor), 100e6);
        vm.prank(otherPayer);
        vm.expectRevert(
            abi.encodeWithSelector(IERC20Errors.ERC20InsufficientAllowance.selector, address(executor), 0, 100e6)
        );
        executor.executePayment(_payment(ID, 100e6));
        assertEq(token.balanceOf(payer), 1_000e6);
        assertEq(token.balanceOf(recipient), 0);
    }

    function test_feeOnTransferTokenFailsClosed() public {
        FeeOnTransferToken fee = new FeeOnTransferToken();
        vm.prank(owner);
        executor.setTokenAllowlisted(address(fee), true);
        fee.mint(payer, 100e6);
        PayoutExecutor.Payment memory payment = _payment(ID, 100e6);
        payment.token = address(fee);
        vm.startPrank(payer);
        fee.approve(address(executor), 100e6);
        vm.expectRevert(abi.encodeWithSelector(PayoutExecutor.TransferAmountMismatch.selector, 100e6, 99e6));
        executor.executePayment(payment);
        vm.stopPrank();
        assertFalse(executor.wasExecuted(payer, ID));
    }

    function test_reentrancyIsBlocked() public {
        ReentrantToken re = new ReentrantToken();
        vm.prank(owner);
        executor.setTokenAllowlisted(address(re), true);
        re.mint(payer, 100e6);
        re.arm(executor, keccak256("reentry"));
        PayoutExecutor.Payment memory payment = _payment(ID, 100e6);
        payment.token = address(re);
        vm.startPrank(payer);
        re.approve(address(executor), 100e6);
        vm.expectRevert(ReentrancyGuard.ReentrancyGuardReentrantCall.selector);
        executor.executePayment(payment);
        vm.stopPrank();
    }

    function test_falseReturningTokenIsRejected() public {
        FalseReturningToken bad = new FalseReturningToken();
        vm.prank(owner);
        executor.setTokenAllowlisted(address(bad), true);
        PayoutExecutor.Payment memory payment = _payment(ID, 1);
        payment.token = address(bad);
        vm.prank(payer);
        vm.expectRevert();
        executor.executePayment(payment);
        assertFalse(executor.wasExecuted(payer, ID));
    }

    function test_onlyOwnerManagesAllowlist() public {
        vm.prank(payer);
        vm.expectRevert(abi.encodeWithSelector(Ownable.OwnableUnauthorizedAccount.selector, payer));
        executor.setTokenAllowlisted(address(token), false);
    }

    function test_digestIsCorrelationOnly() public {
        PayoutExecutor.Payment memory payment = _payment(ID, 1e6);
        payment.manifestDigest = bytes32(uint256(0xdead));
        vm.startPrank(payer);
        token.approve(address(executor), 1e6);
        vm.expectEmit(true, true, true, true, address(executor));
        emit PaymentExecuted(payer, ID, address(token), recipient, 1e6, bytes32(uint256(0xdead)));
        executor.executePayment(payment);
        vm.stopPrank();
    }

    function testFuzz_eachIdExecutesAtMostOnce(bytes32 id, uint96 amount) public {
        vm.assume(id != bytes32(0));
        uint256 value = bound(uint256(amount), 1, 500e6);
        _approveAndPay(payer, id, value);
        vm.startPrank(payer);
        token.approve(address(executor), value);
        vm.expectRevert(abi.encodeWithSelector(PayoutExecutor.AlreadyExecuted.selector, payer, id));
        executor.executePayment(_payment(id, value));
        vm.stopPrank();
        assertEq(token.balanceOf(recipient), value);
    }
}
