// Client communications: monthly email draft with the statements packet attached, and the meeting script. Firm staff only.
import React, { useEffect, useState } from 'react';
import { download, get, postDownload, put } from './api.ts';
import { useT } from './App.tsx';
import { Card, Empty, ErrorNote, Field, Note, P, Pill } from './ui.tsx';

export function ClientComms() {
  const t = useT(); const [d, setD] = useState<any>(null); const [err, setErr] = useState<string | null>(null); const [msg, setMsg] = useState<string | null>(null); const [tab, setTab] = useState('email');
  const [note, setNote] = useState(''); const [subject, setSubject] = useState(''); const [body, setBody] = useState(''); const [to, setTo] = useState(''); const [tpl, setTpl] = useState<{ subject: string; body: string } | null>(null); const [edited, setEdited] = useState(false);
  const load = async (n = note, keepRecipients = false) => { try { const x = await get(`${t.base}/comms?note=${encodeURIComponent(n)}`); setD(x); if (x.ready) { setSubject(x.draft.subject); setBody(x.draft.body); setEdited(false); if (!keepRecipients) setTo(x.recipients.filter((r: any) => r.role === 'client_owner').map((r: any) => r.email).join(', ')); } setErr(null); } catch (e) { setErr((e as Error).message); } };
  useEffect(() => { load('', false); }, [t.tid]);
  if (!d) return <><h1>Client Communications</h1><ErrorNote error={err} /></>;
  const head = <div className="page-h"><div><h1>Client Communications</h1><p className="meta">{d.ready ? <>Monthly deliverables for <b>{P(d.period)}</b> · </> : null}<Pill tone="info">Firm staff only — clients never see this page</Pill></p></div></div>;
  if (!d.ready) return <>{head}<Empty>{d.reason}</Empty></>;
  const act = async (f: () => Promise<void>, done: string) => { setErr(null); setMsg(null); try { await f(); setMsg(done); } catch (e) { setErr((e as Error).message); } };
  const recipients = to.split(/[,;\s]+/).filter(Boolean); const copy = (text: string, what: string) => act(() => navigator.clipboard.writeText(text), `${what} copied.`);
  return <>{head}
    {d.notices.map((n: string) => <Note key={n} tone="warn">{n}</Note>)}
    <div className="tabs" role="tablist">{[['email', 'Monthly email'], ['script', 'Meeting script'], ['template', 'Email template']].map(([k, l]) => <button key={k} role="tab" aria-selected={tab === k} className={tab === k ? 'on' : ''} onClick={() => { setTab(k); setMsg(null); setErr(null); }}>{l}</button>)}</div>
    <ErrorNote error={err} />{msg && <Note tone="good">{msg}</Note>}
    {tab === 'email' && <div className="grid-2">
      <Card title="Draft email" right={<Pill>{edited ? 'Edited by you' : 'From the template'}</Pill>}>
        <Field label="To" hint="Client owners are filled in. Separate addresses with commas."><input value={to} onChange={(e) => setTo(e.target.value)} /></Field>
        <Field label="Subject"><input value={subject} onChange={(e) => { setSubject(e.target.value); setEdited(true); }} /></Field>
        <Field label="Message" hint="Edit freely. Changes here apply to this month's email only."><textarea rows={24} value={body} onChange={(e) => { setBody(e.target.value); setEdited(true); }} /></Field>
        <p className="muted small">Attachment: <b>{d.packetName}</b></p>
        <div className="row wrap"><button className="btn btn-primary" onClick={() => act(() => postDownload(`${t.base}/comms/email.eml`, { to: recipients, subject, body }, d.packetName.replace(/\.pdf$/, '.eml')), 'Draft downloaded. Open it in your mail program, check it, and send.')}>Download email draft with PDF attached</button>
          <button className="btn" onClick={() => act(() => download(`${t.base}/comms/packet.pdf`, d.packetName), 'Packet downloaded.')}>Download the PDF only</button><button className="btn" onClick={() => copy(`${subject}\n\n${body}`, 'Email text')}>Copy text</button></div>
        <p className="muted small">Nothing is sent from here. The draft opens unsent in Outlook, Apple Mail and most desktop mail programs, with the packet already attached, so the email goes out from your own address and replies come back to you.</p>
      </Card>
      <div>
        <Card title="Make it personal"><Field label="Your note for this month" hint="One or two sentences only you could write: a job that closed, a conversation you had, something you noticed."><textarea rows={4} value={note} maxLength={2000} onChange={(e) => setNote(e.target.value)} /></Field>
          <div className="row"><button className="btn" onClick={() => { if (!edited || confirm('Rebuild the draft from the template? Your edits to the message will be replaced.')) load(note, true); }}>Rebuild draft with this note</button></div>
          <p className="muted small">A client can tell a form letter from a note written to them. The figures and highlights are filled in for you so your time goes on this part.</p></Card>
        <Card title="What is in the packet"><ul className="plain"><li>The month at a glance: sales, gross profit, true pretax profit, cash and core capital.</li><li>What stood out, in plain sentences.</li><li>The scorecard with grades{d.scorecardPublished ? ' and your published comments' : ' (calculated; no comments until the scorecard is published)'}.</li><li>Management profit and loss: month, prior month, year to date and rolling twelve.</li><li>Balance sheet with the change from last month.</li></ul>
          <p className="muted small">Built from approved months only. Every page is marked as unaudited management statements.</p></Card>
        <Card title="Figures used"><table className="tbl"><tbody>{['period', 'revenue', 'revenue_ytd', 'pretax_profit', 'pretax_pct', 'pretax_profit_ytd', 'cash'].map((k) => <tr key={k}><td className="muted">{d.mergeFields.find((f: any) => f[0] === k)?.[1]}</td><td className="num">{d.values[k]}</td></tr>)}</tbody></table></Card>
      </div>
    </div>}
    {tab === 'script' && <Card title={d.script.title} right={<Pill>About {d.script.minutes} minutes</Pill>}>
      <p className="meta">For a video call or an in-person review. Say it in your own words; the figures are the ones in the packet and on the client's dashboard.</p>
      <div className="row wrap no-print"><button className="btn" onClick={() => copy(d.scriptText, 'Script')}>Copy script</button><button className="btn" onClick={() => window.print()}>Print / PDF</button></div>
      {d.script.sections.map((s: any, i: number) => <section key={s.heading} className="script-sec"><h3>{i + 1}. {s.heading} <span className="muted">· {s.minutes} min</span></h3>
        {s.say.map((l: string) => <p key={l} className="say">{l}</p>)}
        {s.ask.length > 0 && <><h4>Ask</h4><ul className="plain">{s.ask.map((l: string) => <li key={l}>{l}</li>)}</ul></>}
        {s.internal.length > 0 && <div className="note note-info"><b>Notes to self</b><ul>{s.internal.map((l: string) => <li key={l}>{l}</li>)}</ul></div>}</section>)}
    </Card>}
    {tab === 'template' && (() => { const cur = tpl ?? { subject: d.template.subject, body: d.template.body }; return <div className="grid-2">
      <Card title={`Email template for ${d.values.client_name}`} right={<Pill>{d.template.custom ? 'Customized for this client' : 'Firm default'}</Pill>}>
        <Field label="Subject"><input value={cur.subject} onChange={(e) => setTpl({ ...cur, subject: e.target.value })} /></Field>
        <Field label="Message"><textarea rows={24} value={cur.body} onChange={(e) => setTpl({ ...cur, body: e.target.value })} /></Field>
        <div className="row"><button className="btn btn-primary" onClick={() => act(async () => { await put(`${t.base}/comms/template`, cur); setTpl(null); await load(note, true); }, 'Template saved. The draft has been rebuilt from it.')}>Save template</button>
          {d.template.custom && <button className="btn" onClick={() => { if (confirm('Go back to the firm default wording for this client?')) act(async () => { await put(`${t.base}/comms/template`, { reset: true }); setTpl(null); await load(note, true); }, 'Back to the firm default.'); }}>Reset to firm default</button>}</div>
        {d.template.updatedAt && <p className="muted small">Last changed by {d.template.updatedBy ?? 'staff'}.</p>}
      </Card>
      <Card title="Fields you can use"><p className="muted">Type a field exactly as shown. It is replaced with this client's value each month.</p>
        <table className="tbl"><tbody>{d.mergeFields.map(([k, l]: [string, string]) => <tr key={k}><td><code>{`{{${k}}}`}</code></td><td>{l}</td></tr>)}</tbody></table>
        <p className="muted small">The template is saved per client, so the tone can fit the relationship. A misspelled field is refused rather than sent.</p></Card>
    </div>; })()}
  </>;
}
