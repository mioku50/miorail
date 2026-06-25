1. **Add `wagmi` and `viem` to `artifacts/interface`**
   - I have already added them using `pnpm add wagmi viem`.

2. **Create Wallet Component**
   - Create a `WalletConnect` component (in `artifacts/interface/src/components/WalletConnect.tsx`) to support testnet wallet integration via wagmi baseAccount and coinbaseWallet.
   - It will use the configuration outlined in `.agents/skills/build-on-base/references/migrations/onchainkit/wallet.md`.

3. **Configure Wagmi Provider in `main.tsx`**
   - Add a wagmi config `artifacts/interface/src/wagmi.ts`.
   - Update `artifacts/interface/src/main.tsx` to wrap the app with `WagmiProvider` and include the Base Sepolia chain.

4. **Integrate Wallet in Layout**
   - Update `artifacts/interface/src/components/Layout.tsx` to display the `WalletConnect` component in the header.

5. **Create Playwright test to verify Frontend**
   - Use `frontend_verification_instructions`.
   - Ensure to verify that WalletConnect button renders properly in the layout.

6. **Validate the Tasks**
   - Run validation scripts: `pnpm install`, `pnpm typecheck`, `pnpm test`, and `node scripts/validate_tasks.js`.

7. **Update Task in agent_tasks.json**
   - Use `node -e` script to mark task `T7.2` as `done`.

8. **Pre-commit checks and PR submission**
   - Call `pre_commit_instructions` and submit a draft PR.
