// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {ReentrancyGuardUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {MerkleProof} from "@openzeppelin/contracts/utils/cryptography/MerkleProof.sol";

/**
 * @title PerkosClaimVault
 * @notice The control point for PerkOS Knowledge earnings + $PERKOS rewards.
 *         Instead of the platform pushing payouts (gas + "distributing tokens"
 *         optics), participants PULL: they claim what they're owed from their
 *         dashboard. The vault custodies the funds; the platform only publishes
 *         a Merkle root of who can claim how much.
 *
 *         Two assets, one claim: `usdc` (provider payment earnings) and
 *         `rewardToken` ($PERKOS, bought by the buyback). The root encodes a
 *         CUMULATIVE total per account; an account withdraws the delta since its
 *         last claim, so re-posting roots and partial claims are all safe.
 *
 *         Leaf format (must match the off-chain builder — the openzeppelin
 *         merkle-tree JS lib's StandardMerkleTree, types ["address","uint256","uint256"]):
 *           leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumUsdc, cumReward))))
 *
 *         SECURITY: the root-setter authorizes claims, so it can move funds. By
 *         default only the owner (a Safe multisig) can set roots. The owner MAY
 *         delegate to a hot `distributor` key for automation — that key then
 *         becomes fund-sensitive; pause + owner-withdraw are the backstops.
 *
 *         NOT YET AUDITED. Deploy to Base Sepolia and review before mainnet.
 */
contract PerkosClaimVault is
    Initializable,
    OwnableUpgradeable,
    PausableUpgradeable,
    ReentrancyGuardUpgradeable,
    UUPSUpgradeable
{
    using SafeERC20 for IERC20;

    // --- storage ---

    /// @notice USDC token (provider payment earnings).
    IERC20 public usdc;
    /// @notice $PERKOS token (reward).
    IERC20 public rewardToken;

    /// @notice Current cumulative-claim Merkle root.
    bytes32 public merkleRoot;
    /// @notice Monotonic epoch, bumped on every root update.
    uint256 public epoch;
    /// @notice Optional hot key allowed to set roots (0 = owner-only).
    address public distributor;

    /// @notice Cumulative USDC already claimed per account.
    mapping(address => uint256) public claimedUsdc;
    /// @notice Cumulative reward already claimed per account.
    mapping(address => uint256) public claimedReward;

    uint256[45] private __gap;

    // --- events ---

    event RootUpdated(uint256 indexed epoch, bytes32 root, address indexed by);
    event Claimed(address indexed account, uint256 usdcAmount, uint256 rewardAmount, uint256 indexed epoch);
    event DistributorUpdated(address indexed distributor);
    event RewardTokenUpdated(address indexed rewardToken);
    event OwnerWithdraw(address indexed token, address indexed to, uint256 amount);
    event UpgradeAuthorized(address indexed newImplementation, address indexed by);

    // --- errors ---

    error ZeroAddress();
    error NotAuthorized();
    error InvalidProof();
    error NothingToClaim();

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address initialOwner,
        address usdc_,
        address rewardToken_,
        address distributor_
    ) external initializer {
        if (initialOwner == address(0) || usdc_ == address(0)) {
            revert ZeroAddress();
        }
        __Ownable_init(initialOwner);
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
        usdc = IERC20(usdc_);
        // rewardToken may be 0 at deploy — $PERKOS is bought later by the buyback;
        // wire it with setRewardToken once it exists. Until then the reward leg
        // is inert (USDC payment claims work from day one).
        rewardToken = IERC20(rewardToken_);
        distributor = distributor_; // may be 0 (owner-only)
    }

    // --- admin ---

    /// @notice Set the cumulative-claim root for the next epoch. Owner, or the
    ///         delegated distributor if one is set.
    function setMerkleRoot(bytes32 root) external whenNotPaused {
        if (msg.sender != owner() && !(distributor != address(0) && msg.sender == distributor)) {
            revert NotAuthorized();
        }
        merkleRoot = root;
        unchecked {
            epoch += 1;
        }
        emit RootUpdated(epoch, root, msg.sender);
    }

    /// @notice Delegate root-setting to a hot key (or clear with address(0)).
    function setDistributor(address distributor_) external onlyOwner {
        distributor = distributor_;
        emit DistributorUpdated(distributor_);
    }

    /// @notice Set the reward token ($PERKOS). Deferred from deploy because the
    ///         buyback mints/buys it later; until set, the reward leg is inert.
    function setRewardToken(address rewardToken_) external onlyOwner {
        rewardToken = IERC20(rewardToken_);
        emit RewardTokenUpdated(rewardToken_);
    }

    /// @notice Emergency / treasury sweep — owner can move any token out.
    function ownerWithdraw(address token, address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        IERC20(token).safeTransfer(to, amount);
        emit OwnerWithdraw(token, to, amount);
    }

    function pause() external onlyOwner {
        _pause();
    }

    function unpause() external onlyOwner {
        _unpause();
    }

    // --- claim ---

    /// @notice How much `account` could still withdraw given a (cumUsdc, cumReward)
    ///         entry — i.e. the entry minus what's already been claimed.
    function claimableDelta(address account, uint256 cumUsdc, uint256 cumReward)
        public
        view
        returns (uint256 usdcOwed, uint256 rewardOwed)
    {
        uint256 cu = claimedUsdc[account];
        uint256 cr = claimedReward[account];
        usdcOwed = cumUsdc > cu ? cumUsdc - cu : 0;
        rewardOwed = cumReward > cr ? cumReward - cr : 0;
    }

    /// @notice Pull a participant's owed USDC + $PERKOS. `cumUsdc`/`cumReward`
    ///         are the CUMULATIVE totals from the current root; the vault sends
    ///         the delta vs. what `account` already claimed. Anyone may submit on
    ///         an account's behalf (funds always go to `account`).
    function claim(
        address account,
        uint256 cumUsdc,
        uint256 cumReward,
        bytes32[] calldata proof
    ) external nonReentrant whenNotPaused {
        bytes32 leaf = keccak256(bytes.concat(keccak256(abi.encode(account, cumUsdc, cumReward))));
        if (!MerkleProof.verify(proof, merkleRoot, leaf)) revert InvalidProof();

        (uint256 usdcOwed, uint256 rewardOwed) = claimableDelta(account, cumUsdc, cumReward);
        // The reward leg stays inert until $PERKOS is set; the owed reward stays
        // claimable (claimedReward untouched) so the same proof works once it is.
        if (rewardOwed > 0 && address(rewardToken) == address(0)) rewardOwed = 0;
        if (usdcOwed == 0 && rewardOwed == 0) revert NothingToClaim();

        if (usdcOwed > 0) {
            claimedUsdc[account] = cumUsdc;
            usdc.safeTransfer(account, usdcOwed);
        }
        if (rewardOwed > 0) {
            claimedReward[account] = cumReward;
            rewardToken.safeTransfer(account, rewardOwed);
        }

        emit Claimed(account, usdcOwed, rewardOwed, epoch);
    }

    // --- upgrade ---

    function _authorizeUpgrade(address newImplementation) internal override onlyOwner {
        emit UpgradeAuthorized(newImplementation, msg.sender);
    }
}
