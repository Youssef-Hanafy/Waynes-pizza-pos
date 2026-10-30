import {expect,it,vi} from "vitest";
import {startTipStep,startSignStep} from "../src/lib/pos/checkout-steps";
import {beginCriticalWork,registerUpdateGuard,updateSafety} from "../src/lib/pos/update-activity";
import {createAndroidHardware,type WaynesAndroidInterface} from "../src/hardware/native/bridge";
it("tip and signature lifecycles hold an update guard until explicitly finished",()=>{
 const tip=startTipStep({orderTotalCents:2000,ask:()=>({answer:new Promise(()=>{}),cancel:vi.fn()}),saveTip:vi.fn(),showPay:vi.fn(),onDone:vi.fn(),onView:vi.fn()});
 expect(updateSafety().blockers).toContain("customer tip or signature collection is in progress");tip.skip();expect(updateSafety().blockers).toEqual([]);
 const sign=startSignStep({ask:()=>({answer:new Promise(()=>{}),cancel:vi.fn()}),saveSignature:vi.fn(),thank:vi.fn(),onFinished:vi.fn(),onView:vi.fn()});expect(updateSafety().blockers.length).toBe(1);sign.stop();expect(updateSafety().blockers).toEqual([]);
});
it("a real native printer promise blocks updates through its native acknowledgement",async()=>{
 let callId="";const target={} as Window;
 const android:WaynesAndroidInterface={info:()=>"{}",callerIdStart:vi.fn(),callerIdStop:vi.fn(),callerIdStatus:()=>"{}",printerSend:(id:string)=>{callId=id;}};
 const hardware=createAndroidHardware(android,target);const printed=hardware.printer!.send({host:"192.0.2.1",port:9100,data:""});
 expect(updateSafety().blockers).toContain("native hardware operation is in progress");target.__waynesNativeResult!(callId,true,"","");await printed;expect(updateSafety().blockers).toEqual([]);
});
it("a native timeout remains unsafe until a definitive late acknowledgement",async()=>{
 vi.useFakeTimers();try{
  let id="";const target={} as Window;const hardware=createAndroidHardware({info:()=>"{}",callerIdStart:vi.fn(),callerIdStop:vi.fn(),callerIdStatus:()=>"{}",printerSend:(callId:string)=>{id=callId;}},target);
  const promise=hardware.printer!.send({host:"192.0.2.1",port:9100,data:"",timeoutMs:1});const rejected=expect(promise).rejects.toThrow("did not answer");await vi.advanceTimersByTimeAsync(5002);await rejected;
  expect(updateSafety().blockers.join()).toContain("no confirmed outcome");target.__waynesNativeResult!(id,true,"","");expect(updateSafety().blockers).toEqual([]);
 }finally{vi.useRealTimers();}
});
it("nested work and throwing guards fail closed",()=>{const end1=beginCriticalWork("printing"),end2=beginCriticalWork("printing");end1();expect(updateSafety().blockers).toContain("printing is in progress");end2();const off=registerUpdateGuard("test",()=>{throw Error("state unreadable");});expect(updateSafety().blockers).toContain("register state could not be verified");off();expect(updateSafety().blockers).toEqual([]);});
