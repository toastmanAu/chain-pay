// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import "@testing-library/jest-dom/vitest";
import { UnlockModal } from "./UnlockModal";

afterEach(cleanup);

describe("UnlockModal", () => {
  it("renders nothing when closed", () => {
    const { container } = render(
      <UnlockModal open={false} onSubmit={vi.fn()} onClose={vi.fn()} />,
    );
    expect(container.children.length).toBe(0);
  });

  it("renders the dialog, title, and password input when open", () => {
    render(<UnlockModal open={true} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("dialog")).toBeInTheDocument();
    expect(screen.getByText(/unlock wallet to sign/i)).toBeInTheDocument();
    expect(screen.getByLabelText(/password/i)).toBeInTheDocument();
  });

  it("Confirm button is disabled when password is empty", () => {
    render(<UnlockModal open={true} onSubmit={vi.fn()} onClose={vi.fn()} />);
    expect(screen.getByRole("button", { name: /confirm/i })).toBeDisabled();
  });

  it("enables Confirm once a password is typed", () => {
    render(<UnlockModal open={true} onSubmit={vi.fn()} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "secret123" },
    });
    expect(screen.getByRole("button", { name: /confirm/i })).not.toBeDisabled();
  });

  it("calls onSubmit with the typed password on Confirm click", () => {
    const onSubmit = vi.fn();
    render(<UnlockModal open={true} onSubmit={onSubmit} onClose={vi.fn()} />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "mysecret!" },
    });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    expect(onSubmit).toHaveBeenCalledOnce();
    expect(onSubmit).toHaveBeenCalledWith("mysecret!");
  });

  it("clears the password field before calling onSubmit (security invariant)", () => {
    const onSubmit = vi.fn();
    render(<UnlockModal open={true} onSubmit={onSubmit} onClose={vi.fn()} />);
    const input = screen.getByLabelText(/password/i) as HTMLInputElement;
    fireEvent.change(input, { target: { value: "mysecret!" } });
    fireEvent.click(screen.getByRole("button", { name: /confirm/i }));
    // The field must be cleared BEFORE onSubmit is invoked.
    expect(input.value).toBe("");
    expect(onSubmit).toHaveBeenCalledWith("mysecret!");
  });

  it("calls onClose when Cancel is clicked", () => {
    const onClose = vi.fn();
    render(<UnlockModal open={true} onSubmit={vi.fn()} onClose={onClose} />);
    fireEvent.change(screen.getByLabelText(/password/i), {
      target: { value: "typed" },
    });
    fireEvent.click(screen.getByRole("button", { name: /cancel/i }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("submits on Enter key when password is non-empty", () => {
    const onSubmit = vi.fn();
    render(<UnlockModal open={true} onSubmit={onSubmit} onClose={vi.fn()} />);
    const input = screen.getByLabelText(/password/i);
    fireEvent.change(input, { target: { value: "enter-key-pw" } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("enter-key-pw");
  });

  it("does not submit on Enter key when password is empty", () => {
    const onSubmit = vi.fn();
    render(<UnlockModal open={true} onSubmit={onSubmit} onClose={vi.fn()} />);
    const input = screen.getByLabelText(/password/i);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).not.toHaveBeenCalled();
  });
});
