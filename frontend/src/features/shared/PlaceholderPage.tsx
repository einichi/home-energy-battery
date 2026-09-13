import { Link } from "react-router-dom";

export function PlaceholderPage({ eyebrow, title, description }: { eyebrow: string; title: string; description: string }) {
  return (
    <main className="page">
      <header className="page-heading">
        <div><p className="eyebrow">{eyebrow}</p><h1>{title}</h1><p>{description}</p></div>
      </header>
      <section className="panel coming-soon">
        <span className="coming-soon-mark" aria-hidden="true">◇</span>
        <h2>Foundation route ready</h2>
        <p>This product area will migrate after the shared shell and read-only Overview are validated.</p>
        <div className="button-row">
          <Link className="button" to="/">Return to Overview</Link>
          <a className="button secondary" href="/">Open the current interface</a>
        </div>
      </section>
    </main>
  );
}
