class GoogleJWTResolver {
    constructor(params = {}) {
        this._clientId = '623255759333-fr0ijf03itgc4t70e8aj99iud9lnsuqm.apps.googleusercontent.com';
        this._nonce = params.nonce || null;

        this._jwt = null;
        this._nonce = null;
    }

    async handleGoogleResponse(response) {
        this._jwt = response.credential;

        if (this.__requestPromiseResolver) {
            this.__requestPromiseResolver();
        }
    }

    async request(nonce) {
        if (nonce) {
            this._nonce = nonce;
        }

        this.__requestPromiseResolver = null;
        this.__requestPromise = new Promise((res)=>{
            this.__requestPromiseResolver = res;
        });

        await this.appendScript();

        document.cookie = 'g_state=; Path=/; Expires=Thu, 01 Jan 1970 00:00:01 GMT;'; // refresh cool-down period

        window.google.accounts.id.prompt();

        await this.__requestPromise;

        return this._jwt;
    }

    async appendScript() {
        await new Promise((res)=>{
            if (window.google?.accounts?.id) {
                window.handleGoogleCredentialResponseHandler = (response)=>{
                    this.handleGoogleResponse(response);
                };

                res();
            } else {
                window.handleGoogleCredentialResponse = function (response) {
                    // setting it up for different instances of SingInWithGoogle component
                    if (window.handleGoogleCredentialResponseHandler) {
                        window.handleGoogleCredentialResponseHandler(response);
                    }
                };

                window.handleGoogleCredentialResponseHandler = (response)=>{
                    this.handleGoogleResponse(response);
                };

                const jsScript = document.createElement('script');
                jsScript.id = 'signinwithgoogle_script_tag';
                jsScript.addEventListener('load', () => {
                    const params = {
                        client_id: this._clientId,
                        callback: window.handleGoogleCredentialResponse,
                        nonce: this._nonce,
                        use_fedcm_for_prompt: false,
                        auto_select: false,
                        ux_mode: 'redirect',
                    };
                    console.error('params', params);
                    window.google.accounts.id.initialize(params);
                    res();
                });
                jsScript.src = "https://accounts.google.com/gsi/client";
                document.body.appendChild(jsScript);
            }
        });
    }
}

module.exports = GoogleJWTResolver;