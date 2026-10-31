'use client';
import { useState } from 'react';
import { PosItemDialog } from '@/app/pos/item-dialog';
export default function Counter({ item }) {
  const [result,setResult]=useState(null);
  async function add(line) {
    const response=await fetch('/api/orders',{method:'POST',body:JSON.stringify(line)});
    setResult(await response.json());
  }
  return <>{result ? <p role="status">Database order price: {result.price}</p> : <PosItemDialog item={item} initialLine={null} onAdd={add} onClose={()=>{}} />}</>;
}
