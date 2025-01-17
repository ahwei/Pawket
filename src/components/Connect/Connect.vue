<template>
  <div class="has-text-centered mt-6">
    <div v-if="hasAccount">
      <div class="box mx-6 is-flex is-justify-content-center">
        <img v-if="origin" :src="`${origin}/favicon.ico`" class="image is-24x24 mx-3" />{{ origin }}
      </div>
      <div v-if="stage == 'Verify'">
        <div class="is-size-3 has-text-weighted-bold mb-6">Connect With Pawket</div>
        <div>Enter your password to connect to the site</div>
        <div class="field mx-5 my-3">
          <input
            class="input is-medium"
            type="password"
            v-model="password"
            @keyup.enter="confirm()"
            @input.enter="clearErrorMsg()"
          />
        </div>
        <p class="help is-danger is-size-6" v-if="!isCorrect">{{ $t("verifyPassword.message.error.incorrectPassword") }}</p>
        <div class="has-text-info">Make sure you trust the site you connect</div>
        <footer class="is-fixed-bottom py-4 px-4 has-background-white-ter">
          <button class="button is-pulled-left" @click="close">Cancel</button>
          <b-button class="button is-pulled-right is-primary" @click="confirm" :loading="loading" :disabled="!app">Next</b-button>
        </footer>
      </div>
      <div v-if="stage == 'Account'">
        <div class="is-size-3 has-text-weighted-bold mb-6">Connect With Pawket</div>
        <div>Select an account to use on this site</div>
        <div class="pb-10">
          <div class="box m-3">
            <a
              v-for="(account, idx) in accounts"
              :key="idx"
              :class="{ 'panel-block': true, 'list-item': idx }"
              @click="selectedAcc = idx"
            >
              <input type="radio" class="mr-2 has-text-primary" :checked="selectedAcc == idx" />
              <figure class="image is-32x32" style="margin: auto">
                <img v-if="account.profilePic" class="is-rounded cover" :src="account.profilePic" />
                <img v-else class="is-rounded" src="@/assets/account-circle.svg" />
              </figure>
              <div class="column is-flex my-0 py-0">
                <div class="py-1">
                  <p class="is-size-6">{{ account.name }}({{ account.key.fingerprint }})</p>
                  <p class="is-size-7 has-text-grey has-text-left" v-if="account.tokens && account.tokens.hasOwnProperty(symbol)">
                    {{ demojo(account.tokens[symbol].amount) }}
                  </p>
                  <p class="is-size-7 has-text-grey has-text-left" v-else>Loading Balance..</p>
                </div>
              </div>
            </a>
          </div>
        </div>
        <footer class="is-fixed-bottom py-4 px-4 has-background-white-ter">
          <button v-if="accounts.length > 1" class="button is-pulled-left" @click="stage = 'Account'">Back</button>
          <button v-if="accounts.length == 1" class="button is-pulled-left" @click="close()">Cancel</button>
          <b-button v-if="!authorized" class="button is-pulled-right is-primary" @click="stage = 'Authorize'" :loading="loading"
            >Next</b-button
          >
          <b-button v-if="authorized" class="button is-pulled-right is-primary" @click="openApp()" :loading="loading"
            >Connect</b-button
          >
        </footer>
      </div>
      <div v-if="stage == 'Authorize'">
        <div class="is-size-3 has-text-weighted-bold">{{ `Connect to [${accounts[selectedAcc].name}]` }}</div>
        <div class="has-text-center">Allow this site to:</div>
        <div class="box m-3 p-3 has-text-left">
          <p class="is-flex mt-2">
            <b-icon icon="checkbox-marked-circle-outline"></b-icon>
            <span class="pl-2">View your account addresses, balance, DIDs and activities.</span>
          </p>
          <p class="is-flex my-2">
            <b-icon icon="checkbox-marked-circle-outline"></b-icon>
            <span class="pl-2">Request approval for transactions.</span>
          </p>
        </div>
        <footer class="is-fixed-bottom py-4 px-4 has-background-white-ter">
          <button class="button is-pulled-left" @click="close()">Cancel</button>
          <b-button class="button is-pulled-right is-primary" @click="authorize()" :loading="loading">Connect</b-button>
        </footer>
      </div>
      <div v-if="stage == 'App'">
        <section class="hero is-medium" v-if="loading">
          <div class="hero-body has-text-centered">
            <h1 class="title">Getting Data from Pawket...</h1>
          </div>
        </section>
        <b-loading v-model="loading"></b-loading>
      </div>
    </div>
    <div v-else>
      <div class="is-size-3 has-text-weighted-bold">No Pawket Wallet</div>
      <div class="my-6">You do not have a wallet set up in Pawket.</div>
      <button class="button is-primary" @click="setUp()">Set up Wallet</button>
    </div>
  </div>
</template>

<script lang="ts">
import { demojo } from "@/filters/unitConversion";
import { AccountEntity, CustomCat, OneTokenInfo } from "@/models/account";
import encryption from "@/services/crypto/encryption";
import puzzle from "@/services/crypto/puzzle";
import receive, { DidDetail } from "@/services/crypto/receive";
import utility from "@/services/crypto/utility";
import store from "@/store";
import { getAllCats } from "@/store/modules/account";
import { NotificationProgrammatic as Notification } from "buefy";
import { NetworkInfo, rpcUrl, xchPrefix, xchSymbol } from "@/store/modules/network";
import { getEncryptKey, isPasswordCorrect } from "@/store/modules/vault";
import { Component, Vue } from "vue-property-decorator";
import TakeOffer from "../Offer/Take.vue";
import Send from "../Send/Send.vue";
import SignMessage from "../Cryptography/SignMessage.vue";
import { connectionItem } from "../AccountManagement/AccountInfo.vue";
type Stage = "Verify" | "Account" | "Authorize" | "App";
type SignWithDidData = { did: string; message: string };
type MessageEventSource = Window | MessagePort | ServiceWorker;
@Component
export default class Connect extends Vue {
  public password = "";
  public isCorrect = true;
  public stage: Stage = "Verify";
  public selectedAcc = 0;
  public accounts: AccountEntity[] = [];
  public app = "";
  public data = "";
  public initialNetworkId = "";
  public event: MessageEvent | null = null;
  public loading = false;

  async confirm(): Promise<void> {
    this.loading = true;
    if (!(await isPasswordCorrect(this.password))) {
      this.isCorrect = false;
      return;
    }
    this.isCorrect = true;
    this.accounts = await this.getAccounts();
    this.accounts = this.accounts.filter((acc) => acc.key.privateKey);
    for (let i = 0; i < this.accounts.length; i++) {
      await this.setFirstAddress(this.accounts[i]);
      await this.getXchBalance(this.accounts[i]);
    }
    this.loading = false;
    if (this.accounts.length > 1) {
      this.stage = "Account";
    } else {
      if (this.authorized) this.openApp();
      else this.stage = "Authorize";
    }
  }

  get account(): AccountEntity {
    return this.accounts[this.selectedAcc];
  }

  get connections(): connectionItem[] {
    const connStr = localStorage.getItem("CONNECTIONS");
    if (!connStr) return [];
    const conn = JSON.parse(connStr) as connectionItem[];
    return conn.filter((con) => con.accountFirstAddress == this.account.firstAddress);
  }

  get origin(): string {
    return this.event?.origin ?? "";
  }

  get authorized(): boolean {
    const idx = this.connections.findIndex(
      (conn) => conn.accountFirstAddress == this.accounts[0].firstAddress && conn.url == this.origin
    );
    if (idx > -1) return true;
    return false;
  }

  get source(): MessageEventSource | null {
    return this.event?.source ?? null;
  }

  get dids(): DidDetail[] {
    return this.account.dids ?? [];
  }

  get hasAccount(): boolean {
    return localStorage.getItem("SETTINGS") != null;
  }

  get networks(): NetworkInfo {
    return store.state.network.networks;
  }

  get tokenList(): CustomCat[] {
    return getAllCats(this.account);
  }

  get rpcUrl(): string {
    return rpcUrl();
  }

  get prefix(): string {
    return xchPrefix();
  }

  get symbol(): string {
    return xchSymbol();
  }

  clearErrorMsg(): void {
    this.isCorrect = true;
  }

  authorize(): void {
    const firstAddress = this.accounts[this.selectedAcc].firstAddress;
    if (firstAddress) {
      this.connections.push({ accountFirstAddress: firstAddress, url: this.origin });
      const conn = JSON.stringify(this.connections);
      localStorage.setItem("CONNECTIONS", conn);
      this.openApp();
    }
  }

  demojo(mojo: null | number | bigint, token: OneTokenInfo | null = null, digits = -1, symbol: string | null = null): string {
    return demojo(mojo, token, digits, symbol);
  }

  async setFirstAddress(account: AccountEntity): Promise<void> {
    const privkey = utility.fromHexString(account.key.privateKey);
    const derive = await utility.derive(privkey, false);
    const firstWalletAddressPubkey = utility.toHexString(derive([12381, 8444, 2, 0]).get_g1().serialize());
    Vue.set(account, "firstAddress", await puzzle.getAddress(firstWalletAddressPubkey, this.prefix));
  }

  setUp(): void {
    window.open(window.location.origin);
    this.close();
  }

  async getXchBalance(account: AccountEntity): Promise<void> {
    const privatekey = utility.fromHexString(account.key.privateKey);
    const ps = await puzzle.getPuzzleDetails(privatekey, this.symbol);
    const requests = [{ symbol: this.symbol, puzzles: ps }];
    const records = await receive.getCoinRecords(requests, false, this.rpcUrl);
    const tokenBalance = receive.getTokenBalance(requests, records);
    Vue.set(account, "tokens", tokenBalance);
  }

  async getAccounts(): Promise<AccountEntity[]> {
    const salt = store.state.vault.salt;
    const encryptKey = salt ? await getEncryptKey(this.password) : this.password;
    const accounts = JSON.parse((await encryption.decrypt(store.state.vault.encryptedAccounts, encryptKey)) || "[]");
    store.state.account.accounts = accounts;
    return accounts;
  }

  setNetwork(networkId: string): boolean {
    if (!networkId) return false;
    for (let key in this.networks) {
      if (this.networks[key].chainId == networkId) {
        const network = this.networks[key];
        store.dispatch("switchNetwork", network.name);
        return true;
      }
    }
    return false;
  }

  mounted(): void {
    window.addEventListener("message", (event: MessageEvent) => {
      Object.freeze(event);
      this.event = event;
      if (this.event.origin == window.location.origin) return;
      const data = JSON.parse(this.event.data);
      this.app = data.app;
      this.initialNetworkId = store.state.network.networkId;
      if (!this.setNetwork(data.network)) {
        Notification.open({
          message: "the specified network does not exist",
          type: "is-danger",
          position: "is-top",
          duration: 5000,
        });
        setTimeout(() => this.close(), 5000);
      }
      this.data = data.data;
    });
  }

  openApp(): void {
    switch (this.app) {
      case "take-offer":
        this.openTakeOffer();
        break;
      case "send":
        this.send();
        break;
      case "sign-with-did":
        this.signWithDid();
        break;
      case "get-address":
        this.stage = "App";
        this.getAddress();
        break;
      case "get-did":
        this.stage = "App";
        this.getDid();
        break;
      default:
        Notification.open({
          message: "Invalid Call" + this.app,
          type: "is-danger",
          position: "is-top-right",
          duration: 5000,
        });
    }
  }

  openTakeOffer(): void {
    this.$buefy.modal.open({
      parent: this,
      component: TakeOffer,
      hasModalCard: true,
      trapFocus: true,
      canCancel: [""],
      fullScreen: true,
      props: {
        account: this.account,
        tokenList: this.tokenList,
        inputOfferText: this.data,
      },
      events: { success: this.success },
    });
  }

  send(): void {
    this.$buefy.modal.open({
      parent: this,
      component: Send,
      hasModalCard: true,
      trapFocus: true,
      fullScreen: true,
      canCancel: [""],
      props: { account: this.account, inputAddress: this.data, addressEditable: false },
      events: { success: this.success },
    });
  }

  async signWithDid(): Promise<void> {
    this.loading = true;
    await store.dispatch("refreshDids", { idx: this.selectedAcc });
    this.loading = false;
    let data: SignWithDidData | null = null;
    try {
      data = JSON.parse(this.data) as SignWithDidData;
    } catch (error) {
      Notification.open({
        message: "Failed To Sign: Invalid Input Data",
        type: "is-danger",
        position: "is-top",
        duration: 5000,
      });
    }
    const idx = this.dids.findIndex((did) => did.did == data?.did);
    if (idx == -1) {
      Notification.open({
        message: "Failed To Sign: The Specified DID Does Not Exist in Current Account",
        type: "is-danger",
        position: "is-top",
        duration: 5000,
      });
      return;
    }
    this.$buefy.modal.open({
      parent: this,
      component: SignMessage,
      hasModalCard: true,
      trapFocus: true,
      canCancel: [""],
      fullScreen: true,
      props: {
        account: this.account,
        did: this.dids[idx].analysis,
        initMessage: data?.message,
      },
      events: { signResult: this.sendSignResult },
    });
  }

  sendSignResult(res: string): void {
    this.source?.postMessage(res, { targetOrigin: this.origin });
    this.success();
  }

  async getDid(): Promise<void> {
    this.loading = true;
    await store.dispatch("refreshDids", { idx: this.selectedAcc });
    this.source?.postMessage(
      this.dids.map((did) => did.did),
      { targetOrigin: this.origin }
    );
    this.loading = false;
    this.success();
  }

  getAddress(): void {
    this.source?.postMessage(this.account.firstAddress, { targetOrigin: this.origin });
    this.success();
  }

  success(): void {
    Notification.open({
      message: "Success!",
      type: "is-primary",
      position: "is-top-right",
      duration: 5000,
    });
    setTimeout(() => this.close(), 5000);
  }

  close(): void {
    store.dispatch("switchNetwork", this.initialNetworkId);
    window.close();
  }
}
</script>

<style scoped lang="scss">
.is-fixed-bottom {
  position: fixed;
  bottom: 0;
  width: 100vw;
}

.pb-10 {
  padding-bottom: 10rem;
}
</style>
