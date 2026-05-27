import { Link, Route, Routes } from "react-router-dom";
import { InvoiceList } from "./InvoiceList";
import { NewInvoiceForm } from "./NewInvoiceForm";
import { ReviewInvoiceForm } from "./ReviewInvoiceForm";

export function InvoicesPage() {
  return (
    <div className="invoices-page">
      <header>
        <h1>Invoices</h1>
        <Link to="/invoices/new"><button type="button">+ New invoice</button></Link>
      </header>
      <Routes>
        <Route index element={<InvoiceList />} />
        <Route path="new" element={<NewInvoiceForm />} />
        <Route path=":id/review" element={<ReviewInvoiceForm />} />
      </Routes>
    </div>
  );
}
