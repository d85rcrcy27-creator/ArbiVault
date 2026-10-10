// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Atomic Aave V3 flash-loan executor for ArbiVault.
/// @dev Deploy one instance per hot wallet. It never exposes an owner withdrawal path.
///      Profits above the repayment amount are sent to the immutable HOT_WALLET.
interface IAaveV3Pool {
    function flashLoanSimple(
        address receiverAddress,
        address asset,
        uint256 amount,
        bytes calldata params,
        uint16 referralCode
    ) external;
}

interface IERC20Flash {
    function balanceOf(address account) external view returns (uint256);
    function approve(address spender, uint256 amount) external returns (bool);
    function transfer(address recipient, uint256 amount) external returns (bool);
}

contract ArbiVaultFlashExecutor {
    address public immutable HOT_WALLET;
    IAaveV3Pool public immutable POOL;

    address public constant PANCAKE_V2_ROUTER =
        0x10ED43C718714eb63d5aA57B78B54704E256024E;

    error UnauthorizedCaller();
    error InvalidArguments();
    error InvalidInitiator();
    error TargetNotAllowed(address target);
    error CallFailed(uint256 index, bytes reason);
    error ProfitBelowMinimum(uint256 available, uint256 required);
    error TokenOperationFailed();

    constructor(address pool, address hotWallet) {
        if (pool == address(0) || hotWallet == address(0)) revert InvalidArguments();
        POOL = IAaveV3Pool(pool);
        HOT_WALLET = hotWallet;
    }

    /// @notice Starts an atomic flash loan. Any failed leg or insufficient profit reverts all legs.
    function executeFlashLoan(
        address asset,
        uint256 amount,
        uint256 minProfit,
        address[] calldata targets,
        uint256[] calldata values,
        bytes[] calldata data
    ) external {
        if (msg.sender != HOT_WALLET) revert UnauthorizedCaller();
        if (
            asset == address(0) || amount == 0 || targets.length == 0 ||
            targets.length != values.length || targets.length != data.length ||
            targets.length > 4
        ) revert InvalidArguments();

        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] != PANCAKE_V2_ROUTER) revert TargetNotAllowed(targets[i]);
            // Flash-loan token proceeds are held by this contract; no arbitrary native-value
            // transfers are permitted from the executor.
            if (values[i] != 0 || data[i].length < 4) revert InvalidArguments();
        }

        POOL.flashLoanSimple(
            address(this),
            asset,
            amount,
            abi.encode(minProfit, targets, values, data),
            0
        );
    }

    /// @notice Aave V3 callback; callable only by the configured pool for this contract's loan.
    function executeOperation(
        address asset,
        uint256 amount,
        uint256 premium,
        address initiator,
        bytes calldata params
    ) external returns (bool) {
        if (msg.sender != address(POOL)) revert UnauthorizedCaller();
        if (initiator != address(this)) revert InvalidInitiator();

        (uint256 minProfit, address[] memory targets, uint256[] memory values, bytes[] memory data) =
            abi.decode(params, (uint256, address[], uint256[], bytes[]));

        for (uint256 i; i < targets.length; ++i) {
            if (targets[i] != PANCAKE_V2_ROUTER) revert TargetNotAllowed(targets[i]);
            (bool ok, bytes memory result) = targets[i].call{value: values[i]}(data[i]);
            if (!ok) revert CallFailed(i, result);
        }

        uint256 repayment = amount + premium;
        uint256 balance = IERC20Flash(asset).balanceOf(address(this));
        uint256 required = repayment + minProfit;
        if (balance < required) revert ProfitBelowMinimum(balance, required);

        uint256 profit = balance - repayment;
        if (profit != 0 && !IERC20Flash(asset).transfer(HOT_WALLET, profit)) {
            revert TokenOperationFailed();
        }
        if (!IERC20Flash(asset).approve(address(POOL), repayment)) {
            revert TokenOperationFailed();
        }
        return true;
    }

    receive() external payable {
        revert UnauthorizedCaller();
    }
}
