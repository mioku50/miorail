import { base } from '@base-org/account';

async function test() {
    const chargeCalls = await base.subscription.prepareCharge({
        id: "test",
        amount: "1",
        testnet: true
    });
    console.log(chargeCalls);
}
