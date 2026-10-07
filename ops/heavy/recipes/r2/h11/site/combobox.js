function combobox(host,id,labelId,options){
  const input=document.createElement('input');input.type='text';input.id=id;input.setAttribute('role','combobox');
  input.setAttribute('aria-labelledby',labelId);input.setAttribute('aria-expanded','false');input.setAttribute('aria-autocomplete','list');input.placeholder='Select...';
  const list=document.createElement('ul');list.setAttribute('role','listbox');list.id=id+'-list';list.hidden=true;input.setAttribute('aria-controls',list.id);
  const render=q=>{list.innerHTML='';options.filter(o=>o.toLowerCase().includes(q.toLowerCase())).forEach(o=>{const li=document.createElement('li');li.setAttribute('role','option');li.textContent=o;li.onmousedown=e=>{e.preventDefault();input.value=o;input.dataset.value=o;close();input.dispatchEvent(new Event('change',{bubbles:true}));};list.appendChild(li);});};
  const open=()=>{render(input.value);list.hidden=false;input.setAttribute('aria-expanded','true');};
  const close=()=>{list.hidden=true;input.setAttribute('aria-expanded','false');};
  input.addEventListener('focus',open);input.addEventListener('input',open);input.addEventListener('blur',()=>setTimeout(close,100));
  input.addEventListener('keydown',e=>{if(e.key==='Enter'&&!list.hidden&&list.firstChild){e.preventDefault();input.value=list.firstChild.textContent;input.dataset.value=input.value;close();}});
  host.appendChild(input);host.appendChild(list);
}
