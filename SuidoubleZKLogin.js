const { generateNonce, generateRandomness, jwtToAddress, getZkLoginSignature, genAddressSeed } = require('@mysten/zklogin');
const { Ed25519Keypair } = require('@mysten/sui.js/keypairs/ed25519');
const { fromB64 } = require('@mysten/bcs');
const { toBigIntBE } = require('bigint-buffer');
const { decodeJwt } = require("jose");

class SuidoubleZKLogin extends EventTarget {
    constructor(params = {}) {
        super(params);

        // this._suiMaster = params.suiMaster;
        // if (!this._suiMaster) {
        //     throw new Error('suiMaster is required');
        // }

        this._provider = params.provider || null;
        this._salt = params.salt || null;
        this._prover = params.prover || null;

        if (!this._provider) {
            throw new Error('provider is required');
        }
        if (!this._salt) {
            throw new Error('salt value or function is required');
        }
        if (!this._prover) {
            throw new Error('prover function or server URL is required');
        }

        this._forEpochs = params.forEpochs || 2;



        this._saltCached = null; // raw value we set after all calculations

        this._jwt = params.jwt || null;
        this._ephemeralKeyPair = null;
        this._randomness = null;
        this._maxEpoch = null;

        this._nonce = null;

        this._state = {
            maxEpoch: null,
            addressSeed: null,
            address: null,
            proofs: null,
            ephemeralKeyPair: null,
        };
        this._stateIsOk = false;

        if (params.state) {
            this._state = params.state;
            if (params.state.maxEpoch) {
                this._maxEpoch = params.state.maxEpoch;
            }
            if (params.state.ephemeralKeyPair && params.state.ephemeralKeyPair.privateKey) {
                const bytes = fromB64(params.state.ephemeralKeyPair.privateKey);
                // console.error('bytes', bytes);
                this._ephemeralKeyPair = Ed25519Keypair.fromSecretKey(bytes);
                // console.error('bytes', this._state.ephemeralKeyPair);
                // console.error('bytes', this._state.ephemeralKeyPair.toSuiAddress());
            }
        }
    }

    get state() {
        return this._state;
    }

    async setJwt(jwt) {
        this._jwt = jwt;

        await this.getProofs(); 
        // it's ok to get proofs just before sending transaction actually, no need to do this on sign in.
        // Not sure what is the best place (as it's slow)

        if (this.__waitForJWTPromiseResolver) {
            this.__waitForJWTPromiseResolver();
        }
    }

    async initialize() {
        if (this.__initializationPromise) {
            return await this.__initializationPromise;
        }
        // to be sure it's executed only once, with respect to async
        this.__initializationPromiseResolver = null;
        this.__initializationPromise = new Promise((res)=>{
            this.__initializationPromiseResolver = res;
        });

        try {
            if (this._state && this._state.proofs && this._state.address) {
                // state is set, so let's check if maxEpoch is not yet passed
                const { epoch } = await this._provider.getLatestSuiSystemState();
                if (epoch && parseInt(''+epoch, 10) <= parseInt(''+this._state.maxEpoch, 10)) {
                    // we are fine
                    this._stateIsOk = true;
                } else {
                    // we need to re-generate proofs
                    this._stateIsOk = false;
                }
            } else {
                // no state passed. 
                this._stateIsOk = false;
            }
        } catch (e) {
            console.error(e);
            this._stateIsOk = false
        }

        if (!this._stateIsOk) {
            await this.getNonce(); // we are generating the nonce, so user can re-sign in

            this.__waitForJWTPromiseResolver = null;
            this.__waitForJWTPromise = new Promise((res)=>{
                this.__waitForJWTPromiseResolver = res;
            });

            this.dispatchEvent(new Event('waitForJWT'));
        }

        this.__initializationPromiseResolver();

        if (this._stateIsOk) {
            this.dispatchEvent(new Event('ready'));
        }

        return this._stateIsOk;
    }

    async waitTillReady() {
        await this.initialize();
        if (this.__waitForJWTPromise) {
            await this.__waitForJWTPromise;
        }
    }

    get connectedAddress() {
        return this.toSuiAddress();
    }

    async getSalt() {
        if (typeof (this._salt) === 'function') {
            const jwtParsed = decodeJwt(this._jwt);
    
            this._saltCached = await this._salt({
                jwt: this._jwt,
                parsed: jwtParsed,
            });

            return this._saltCached;
        }

        this._saltCached = this._salt;
        return this._salt;        
    }

    async getNonce() {
        if (this._nonce) {
            return this._nonce;
        }

        const client = this._provider;
        const { epoch } = await client.getLatestSuiSystemState();
        this._maxEpoch = Number(epoch) + this._forEpochs; // this means the ephemeral key will be active for N epochs from now.
        const randomness = generateRandomness();
        this._randomness = randomness;
        this._ephemeralKeyPair = new Ed25519Keypair();
        const nonce = generateNonce(this._ephemeralKeyPair.getPublicKey(), this._maxEpoch, randomness);

        this._nonce = nonce;

        return nonce;
    }

    toSuiAddress() {
        if (this._state && this._state.address) {
            return this._state.address;
        } else if (this._saltCached) { // should be sync to match Sui's Keypair's methods
            return jwtToAddress(this._jwt, this._saltCached);
        } else {
            return null;
        }
    }

    async getProofs() {
        // should be executed after getNonce();
        if (!this._ephemeralKeyPair) {
            throw new Error('be sure to execute getProofs() after getNonce(), and setJWT() on the same instance you got nonce from');
        }

        if (this._stateIsOk && this._state && this._state.proofs) {
            return {
                ...(this._state.proofs),
                addressSeed: this._state.addressSeed,
            };
        }

        const salt = await this.getSalt();

        const toProof = {
            jwt: this._jwt,
            extendedEphemeralPublicKey: toBigIntBE(
                Buffer.from(this._ephemeralKeyPair.getPublicKey().toSuiBytes())
            ).toString(),
            maxEpoch: this._maxEpoch,
            jwtRandomness: this._randomness.toString(),
            salt: salt,
            keyClaimName: "sub",
        };
        const jwtParsed = decodeJwt(this._jwt);

        let proofs = null;
        if (typeof(this._prover) === 'function') {
            proofs = await this._prover(toProof);
        } else {
            // _prover is a server url
            const response = await fetch(this._prover, {
                method: "POST",
                headers: {
                    "Content-Type": "application/json",
                },
                body: JSON.stringify(toProof),
            });
            proofs = await response.json();
        }

        const addressSeed = genAddressSeed(
            salt,
            'sub',
            jwtParsed.sub,
            (Array.isArray(jwtParsed.aud) ? jwtParsed.aud[0] : jwtParsed.aud)
        );

        this._state = {
            address: this.toSuiAddress(),
            proofs: proofs,
            maxEpoch: this._maxEpoch,
            addressSeed: addressSeed.toString(),
            ephemeralKeyPair: this._ephemeralKeyPair.export(),
        };
        this._stateIsOk = true;

        this.dispatchEvent(new Event('state'));
        this.dispatchEvent(new Event('ready'));

        console.log('state', this._state);

        return {
            ...proofs,
            addressSeed: addressSeed.toString(),
        };
    }

    async signAndExecuteTransactionBlock(params) {
        await this.waitTillReady();

        const client = this._provider;
        const txb = params.transactionBlock;

        txb.setSenderIfNotSet(this.toSuiAddress());

        console.error('client', client);
        console.error('client', this._ephemeralKeyPair);
        const { bytes, signature } = await txb.sign({
            client,
            signer: this._ephemeralKeyPair,
        });

        const proofs = await this.getProofs();

        const getZkLoginSignatureParams = {
            inputs: proofs,
            maxEpoch: this._maxEpoch,
            userSignature: signature,
        };

        const zkLoginSignature = getZkLoginSignature(getZkLoginSignatureParams);
        
        return await client.executeTransactionBlock({
            transactionBlock: bytes,
            signature: zkLoginSignature,
        });
    }

}

module.exports = SuidoubleZKLogin;