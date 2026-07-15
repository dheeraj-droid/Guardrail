// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { MobileNav } from '@/app/MobileNav';

afterEach(cleanup);

describe('MobileNav', () => {
  it('starts closed with the panel hidden and aria-expanded=false', () => {
    render(<MobileNav configured login={null} />);
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    expect(toggle.getAttribute('aria-controls')).toBe('mobile-menu');
    // Panel is present but hidden.
    const panel = document.getElementById('mobile-menu');
    expect(panel).not.toBeNull();
    expect(panel?.hasAttribute('hidden')).toBe(true);
  });

  it('opens on hamburger click: aria-expanded flips true and panel is shown', () => {
    render(<MobileNav configured login={null} />);
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(toggle);

    const reOpened = screen.getByRole('button', { name: 'Close navigation' });
    expect(reOpened.getAttribute('aria-expanded')).toBe('true');
    const panel = document.getElementById('mobile-menu');
    expect(panel?.hasAttribute('hidden')).toBe(false);
    expect(panel?.className).toContain('is-open');
  });

  it('toggles closed on a second click', () => {
    render(<MobileNav configured login={null} />);
    const toggle = screen.getByRole('button', { name: 'Open navigation' });
    fireEvent.click(toggle); // open
    fireEvent.click(screen.getByRole('button', { name: 'Close navigation' })); // close

    const toggleAgain = screen.getByRole('button', { name: 'Open navigation' });
    expect(toggleAgain.getAttribute('aria-expanded')).toBe('false');
    expect(document.getElementById('mobile-menu')?.hasAttribute('hidden')).toBe(true);
  });

  it('closes when Escape is pressed', () => {
    render(<MobileNav configured login={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(document.getElementById('mobile-menu')?.hasAttribute('hidden')).toBe(false);

    fireEvent.keyDown(document, { key: 'Escape' });

    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(document.getElementById('mobile-menu')?.hasAttribute('hidden')).toBe(true);
  });

  it('closes when a nav link is clicked', () => {
    render(<MobileNav configured login={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));

    fireEvent.click(screen.getByRole('link', { name: 'How it works' }));

    expect(screen.getByRole('button', { name: 'Open navigation' }).getAttribute('aria-expanded')).toBe(
      'false',
    );
    expect(document.getElementById('mobile-menu')?.hasAttribute('hidden')).toBe(true);
  });

  it('shows a Sign in CTA when configured and signed out, and the session chip when signed in', () => {
    render(<MobileNav configured login={null} />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByRole('link', { name: /Sign in with GitHub/ })).not.toBeNull();

    cleanup();
    render(<MobileNav configured login="octocat" />);
    fireEvent.click(screen.getByRole('button', { name: 'Open navigation' }));
    expect(screen.getByText('@octocat')).not.toBeNull();
  });
});
