# suidouble-zklogin

zkLogin implementation as wrapper following Sui KeyPair methods signature

very alpha for now. Only `signAndExecuteTransactionBlock` is supported. Please start and wait for a release.

### sample usage

```javascript
import SuidoubleZKLogin from "./SuidoubleZKLogin.js";
import GoogleJWTResolver from "./GoogleJWTResolver.js";
const { SuiClient, getFullnodeUrl } = require('@mysten/sui.js/client');

// try to restore state from localStorage
const stateJSON = localStorage.getItem("zkLoginState");
let state = null;
try {
    state = JSON.parse(stateJSON);
    if (!state.maxEpoch) {
        state = null;
    }
} catch (e) {
    console.error(e);
}
console.log('restored state: ', state);

// initialize zkLogin signer instance
const zk = new SuidoubleZKLogin({
        provider: new SuiClient({url: getFullnodeUrl('mainnet')}),
        prover: 'http://localhost:8095/http://host.docker.internal:8098/v1', // prover server URL
        state: state,                                                        // state to be restored ( may be empty )
        salt: async(params)=>{
            console.log('asked for a salt for jwt', params.jwt, params.parsed);
            return '129390038577185583942388216820280642146'; // should return some hash
        },
    });
zk.addEventListener('state', async()=>{
    console.log('got state. A place to save it somewhere in LocalStorage for example');
    console.log(zk.state);

    localStorage.setItem("zkLoginState", JSON.stringify(zk.state));
});
zk.addEventListener('waitForJWT', async()=>{
    console.log('there is no state provided, but nonce is generated, so we can ask oAuth for a jwt token');
    const nonce = await zk.getNonce();
    
    const googleJWTResolver = new GoogleJWTResolver({
        nonce: nonce,
        clientId: '2342342342-afsdfasdfsadfasdfasdfsdf.apps.googleusercontent.com',
    });
    const jwt = await googleJWTResolver.request();

    console.log('got jwt from auth provider', jwt);

    zk.setJwt(jwt);
});
zk.addEventListener('ready', async()=>{
    console.log('we got all proofs and are ready to sign transactions');
    console.log('user wallet address is: ', zk.toSuiAddress());

    const client = new SuiClient({url: getFullnodeUrl('mainnet')}); // or zk.client

    const result = await client.signAndExecuteTransactionBlock({
        signer: zk,
        transactionBlock: txb,
        requestType: 'WaitForLocalExecution',
        options: {
            showType: true,
            showContent: true,
            showOwner: true,
            showDisplay: true,
        },
    });
});

await zk.initialize();
```
