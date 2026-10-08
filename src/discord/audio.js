// Discord PCM48kHz/2chと、OpenAI PCM24kHz/1chの変換。
// ネットワーク・デコーダの境界で分割されたサンプルを次へ持ち越す。
export class Downsample {
  constructor(){this.tail=Buffer.alloc(0);}
  convert(chunk){
    const input=Buffer.concat([this.tail,chunk]),length=input.length-input.length%8;
    const output=Buffer.alloc(length/4);
    for(let i=0,j=0;i<length;i+=8,j+=2){
      const value=(input.readInt16LE(i)+input.readInt16LE(i+2)+input.readInt16LE(i+4)+input.readInt16LE(i+6))/4;
      output.writeInt16LE(Math.round(value),j);
    }
    this.tail=Buffer.from(input.subarray(length));return output;
  }
}
export function upsample(input){
  if(input.length%2)throw new Error('生成音声のPCMが不正です。');
  const output=Buffer.alloc(input.length*4);
  for(let i=0,j=0;i<input.length;i+=2,j+=8){const value=input.readInt16LE(i);for(let k=0;k<8;k+=2)output.writeInt16LE(value,j+k);}
  return output;
}

// Discordの「音声パケットを送信中」には無音も含まれる。再生の割り込みはPCMの音量で判定する。
export class VoiceActivity {
  constructor(onChange,{threshold=.006,startMs=60,endMs=300}={}){this.onChange=onChange;this.threshold=threshold;this.startMs=startMs;this.endMs=endMs;this.active=false;this.loudMs=0;this.quietMs=0;}
  write(pcm){
    if(pcm.length%4)throw new Error('DiscordのPCMフレームが不正です。');
    if(!pcm.length)return;
    let energy=0;for(let i=0;i<pcm.length;i+=2){const value=pcm.readInt16LE(i)/32768;energy+=value*value;}
    const loud=Math.sqrt(energy/(pcm.length/2))>=this.threshold,ms=pcm.length/192;
    if(loud){this.loudMs+=ms;this.quietMs=0;if(!this.active&&this.loudMs>=this.startMs){this.active=true;this.onChange(true);}}
    else{this.loudMs=0;this.quietMs+=ms;if(this.active&&this.quietMs>=this.endMs){this.active=false;this.onChange(false);}}
  }
  end(){if(this.active){this.active=false;this.onChange(false);}this.loudMs=0;this.quietMs=0;}
}
