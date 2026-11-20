/** Each mounted form gets its own document: Payarc's SDK uses global mutable state. */
export function payarcFieldsDocument(clientId: string, environment: string, channel: string, parentOrigin: string) {
  const portal = environment === "production" ? "https://portal.payarc.net" : "https://testportal.payarc.net";
  const literal = (value: string) => JSON.stringify(value).replaceAll("<", "\\u003c");
  return `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1">
<style id="payarc-styles">html,body{margin:0;padding:0}.payarc-all{box-sizing:border-box}.payarc-input{box-sizing:border-box;width:100%;height:44px;min-height:44px;margin:0;padding:10px;border:1px solid #bbb;border-radius:8px;font:16px Arial,sans-serif}.payarc-label{display:block;margin:0 0 4px;font:14px/18px Arial,sans-serif}.payarc-container,.payarc-row{width:100%;margin:0;padding:0}.payarc-label-container,.payarc-input-container{float:none;width:100%;margin:0;padding:0}</style>
<style>html{margin:0}body{box-sizing:border-box;margin:0;padding:12px;background:white;font:14px Arial,sans-serif}#fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:10px}#fields>[data-payarc]{height:76px;min-width:0}#number,#zip{grid-column:1/-1}#fields iframe{display:block;border:0;width:100%!important;height:100%!important;min-height:0}#status{color:#9b2424;overflow-wrap:anywhere;margin-top:8px}#status:empty{display:none}</style></head><body>
<div id="fields"><div id="number" data-payarc="CARD_NUMBER" data-placeholder="Card number"></div><div id="expiry" data-payarc="EXP" data-placeholder="MM/YY"></div><div id="cvv" data-payarc="CVV" data-placeholder="Security code"></div><div id="zip" data-payarc="ZIP" data-placeholder="Billing ZIP"></div></div><button id="tokenize" hidden type="button">Tokenize</button><div id="status" role="status"></div>
<script>
const channel=${literal(channel)};const origin=${literal(parentOrigin)};
const send=(type,value)=>parent.postMessage({channel,type,...value},origin);
new ResizeObserver(()=>send('resize',{height:Math.ceil(document.body.getBoundingClientRect().height)})).observe(document.body);
let active=false;
window.addEventListener('message',event=>{if(event.source===parent&&event.origin===origin&&event.data?.channel===channel&&event.data.type==='tokenize'&&!active){if(!document.getElementById('tokenize').dataset.uuid){send('error',{message:'Complete the card details first.'});return;}active=true;getPayarcToken(document.getElementById('tokenize'));}});
// Payarc echoes this URL as postMessage's targetOrigin. srcdoc has an inherited
// HTTPS origin but location.href is about:srcdoc, which cannot receive that reply.
function initialize(){try{window.getStyles=field=>field.contentWindow.postMessage({styles:document.getElementById('payarc-styles').innerText,url:origin},${literal(portal)});initPayarcTokenizer(${literal(clientId)},{FORM_STATUS:'status',INITIATE_PAYMENT:'tokenize',FIELDS_CONTAINER:'fields',TOKEN_CALLBACK:{success:obj=>{active=false;try{const data=JSON.parse(obj.response);if(typeof data.token!=='string'||!data.token)throw new Error();send('token',{token:data.token});}catch{send('error',{message:'Payarc returned an invalid card token.'});}},error:()=>{active=false;send('error',{message:'Check the card details and try again.'});}}});}catch{send('error',{message:'Secure card entry could not load.'});}}
const observer=new MutationObserver(()=>{if(document.querySelector('#fields iframe')){send('ready',{});observer.disconnect();}});observer.observe(document.getElementById('fields'),{childList:true,subtree:true});
</script><script src="${portal}/js/iframeprocess.js" onload="initialize()" onerror="send('error',{message:'Payarc card entry could not load.'})"></script></body></html>`;
}
