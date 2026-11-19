/** Each mounted form gets its own document: Payarc's SDK uses global mutable state. */
export function payarcFieldsDocument(clientId: string, environment: string, channel: string, parentOrigin: string) {
  const portal = environment === "production" ? "https://portal.payarc.net" : "https://testportal.payarc.net";
  const literal = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style id="payarc-styles">.payarc-input{box-sizing:border-box;width:100%;min-height:44px;padding:10px;border:1px solid #bbb;border-radius:8px;font-size:16px}.payarc-label{font-family:Arial,sans-serif;font-size:14px}.payarc-container{width:100%}</style>
<style>body{margin:0;background:white;font:14px Arial,sans-serif}#fields{display:grid;gap:8px}iframe{border:0;width:100%;min-height:58px}#status{color:#9b2424;min-height:20px}</style></head><body>
<div id="fields"><div id="number" data-payarc="CARD_NUMBER" data-placeholder="Card number"></div><div id="expiry" data-payarc="EXP" data-placeholder="MM/YY"></div><div id="cvv" data-payarc="CVV" data-placeholder="Security code"></div><div id="zip" data-payarc="ZIP" data-placeholder="Billing ZIP"></div></div><button id="tokenize" hidden type="button">Tokenize</button><div id="status" role="status"></div>
<script>
const channel=${literal(channel)};const origin=${literal(parentOrigin)};
const send=(type,value)=>parent.postMessage({channel,type,...value},origin);
let active=false;
window.addEventListener('message',event=>{if(event.source===parent&&event.origin===origin&&event.data?.channel===channel&&event.data.type==='tokenize'&&!active){if(!document.getElementById('tokenize').dataset.uuid){send('error',{message:'Complete the card details first.'});return;}active=true;getPayarcToken(document.getElementById('tokenize'));}});
function initialize(){try{initPayarcTokenizer(${literal(clientId)},{FORM_STATUS:'status',INITIATE_PAYMENT:'tokenize',FIELDS_CONTAINER:'fields',TOKEN_CALLBACK:{success:obj=>{active=false;try{const data=JSON.parse(obj.response);if(typeof data.token!=='string'||!data.token)throw new Error();send('token',{token:data.token});}catch{send('error',{message:'Payarc returned an invalid card token.'});}},error:()=>{active=false;send('error',{message:'Check the card details and try again.'});}}});}catch{send('error',{message:'Secure card entry could not load.'});}}
const observer=new MutationObserver(()=>{if(document.querySelector('#fields iframe')){send('ready',{});observer.disconnect();}});observer.observe(document.getElementById('fields'),{childList:true,subtree:true});
</script><script src="${portal}/js/iframeprocess.js" onload="initialize()" onerror="send('error',{message:'Payarc card entry could not load.'})"></script></body></html>`;
}
