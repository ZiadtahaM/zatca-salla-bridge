import os
import sys
import time
from playwright.sync_api import sync_playwright

OUTPUT_DIR = os.path.join(os.getcwd(), '.scratch', 'human_journey')
os.makedirs(OUTPUT_DIR, exist_ok=True)

def run_human_browser_journey():
    print("==================================================================")
    print("STARTING REAL HUMAN E2E BROWSER JOURNEY IN HEADLESS CHROMIUM")
    print("==================================================================")
    
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        context = browser.new_context(
            viewport={'width': 1280, 'height': 900},
            locale='ar-SA'
        )
        page = context.new_page()

        # Step 1: Human enters root URL http://127.0.0.1:3000/
        print("\n[Step 1] Visiting http://127.0.0.1:3000/ (Testing Root Redirect & Session Cookie)...")
        response = page.goto('http://127.0.0.1:3000/', wait_until='networkidle')
        assert response.status == 200, f"Expected status 200, got {response.status}"
        assert '/portal' in page.url, f"Expected redirect to /portal, current URL: {page.url}"
        
        # Verify Session Cookie
        cookies = context.cookies()
        session_cookie = next((c for c in cookies if c['name'] == 'zatca_merchant_session'), None)
        assert session_cookie is not None, "zatca_merchant_session cookie must be set on page visit"
        assert session_cookie['httpOnly'] == True, "Cookie must be HttpOnly"
        print(f" -> Session cookie acquired: {session_cookie['name']} (HttpOnly: {session_cookie['httpOnly']}, SameSite: {session_cookie['sameSite']})")

        # Step 2: Tab 1 Cutover Warning & Liability Checkbox Verification
        print("\n[Step 2] Verifying Tab 1: 1-Click ZATCA Activation & Cutover Warning...")
        cutover_elem = page.locator('strong:has-text("تنبيه خطة التحول والانتقال (Cutover Warning)")')
        assert cutover_elem.is_visible(), "Cutover warning must be visible to human merchant"
        liability_checkbox = page.locator('input#liabilityAccepted')
        assert liability_checkbox.is_visible(), "Mandatory liability waiver checkbox must be present"
        
        shot1 = os.path.join(OUTPUT_DIR, '01_portal_activation_cutover.png')
        page.screenshot(path=shot1, full_page=False)
        print(f" -> Saved screenshot: {shot1}")

        # Step 3: Human clicks Live 1-Click Test Demo Invoice
        print("\n[Step 3] Clicking 'إصدار وتوثيق فاتورة تجريبية حية'...")
        demo_btn = page.locator('button[onclick="generateLiveTestInvoice()"]')
        assert demo_btn.is_visible(), "Demo generation button must be visible in hero banner"
        demo_btn.click()

        # Wait for modal to pop up
        page.wait_for_selector('#invoice-preview-modal.open', timeout=10000)
        print(" -> Invoice preview modal opened successfully!")

        # Verify modal elements
        uuid_text = page.locator('#inv-modal-uuid').inner_text()
        total_text = page.locator('#inv-modal-total').inner_text()
        qr_img = page.locator('#inv-modal-qr-img')
        assert qr_img.is_visible(), "QR code image must be visible in modal"
        qr_src = qr_img.get_attribute('src')
        assert '/api/invoices/' in qr_src and '/qr' in qr_src, f"Invalid QR source: {qr_src}"
        print(f" -> Live Invoice Created in DOM: UUID={uuid_text}, Total={total_text} SAR, QR URL={qr_src}")

        shot2 = os.path.join(OUTPUT_DIR, '02_live_invoice_preview_modal.png')
        page.screenshot(path=shot2, full_page=False)
        print(f" -> Saved screenshot: {shot2}")

        # Extract invoice ID from the modal's PDF link for later direct navigation
        pdf_link = page.locator('#inv-modal-pdf-link').get_attribute('href')
        invoice_id = pdf_link.split('/api/invoices/')[1].split('/pdf')[0]

        # Close the modal
        close_btn = page.locator('#invoice-preview-modal button:has-text("إغلاق")')
        close_btn.click()
        page.wait_for_load_state('networkidle')

        # Step 4: Human navigates to Tab 3 (سجل الفواتير)
        print("\n[Step 4] Navigating to Tab 3: Invoice Registry & Accountant Tax Export...")
        tab3_btn = page.locator('button[onclick*="switchTab(\'invoices\'"]')
        tab3_btn.click()
        page.wait_for_selector('#tab-invoices.active', timeout=5000)

        # Download VAT Return Reconciliation CSV
        print(" -> Clicking 'تصدير الإقرار الضريبي لبرنامج المحاسب (Excel / CSV معتمد)'...")
        with page.expect_download() as download_info:
            export_btn = page.locator('a[href*="/api/invoices/export.csv"]')
            export_btn.click()
        download = download_info.value
        csv_path = os.path.join(OUTPUT_DIR, 'downloaded_vat_return.csv')
        download.save_as(csv_path)
        
        with open(csv_path, 'rb') as f:
            csv_bytes = f.read()
        
        # Verify UTF-8 BOM
        assert csv_bytes[:3] == b'\xEF\xBB\xBF', "Downloaded CSV must contain UTF-8 BOM for Arabic Excel rendering"
        csv_text = csv_bytes.decode('utf-8')
        assert "ZATCA VAT Return Form Summary" in csv_text, "Missing ZATCA VAT Return Form Summary"
        assert "Box 1 Standard Sales" in csv_text, "Missing Box 1 Standard Sales"
        assert "Net VAT Payable" in csv_text, "Missing Net VAT Payable"
        print(f" -> Accountant CSV Export successfully downloaded ({len(csv_bytes)} bytes) with verified UTF-8 BOM!")

        shot3 = os.path.join(OUTPUT_DIR, '03_tab3_invoices_registry.png')
        page.screenshot(path=shot3, full_page=False)
        print(f" -> Saved screenshot: {shot3}")

        # Step 5: Historical Order Return (Pre-Installation 381 Credit Note)
        print("\n[Step 5] Testing Historical Order Refund Modal (Pre-Installation 381)...")
        hist_btn = page.locator('button[onclick*="openHistoricalCreditDialog"]')
        hist_btn.click()
        page.wait_for_selector('#credit-modal.open', timeout=5000)

        # Check historical fields are visible
        hist_box = page.locator('#credit-external-fields')
        assert hist_box.is_visible(), "External order input fields must be visible for historical returns"

        # Type refund amount and verify live math updates
        page.fill('#credit-amount', '230.00')
        page.wait_for_timeout(200)
        net_calc = page.locator('#credit-math-net').inner_text()
        vat_calc = page.locator('#credit-math-vat').inner_text()
        assert net_calc == '200.00', f"Expected net 200.00, got {net_calc}"
        assert vat_calc == '30.00', f"Expected vat 30.00, got {vat_calc}"
        print(f" -> Live Halala Rounding Math Verified in DOM: 230.00 SAR => Net {net_calc} SAR, 15% VAT {vat_calc} SAR")

        # Fill external order number
        page.fill('#credit-external-num', 'SALLA-HISTORICAL-ORD-2023-8811')
        
        shot4 = os.path.join(OUTPUT_DIR, '04_historical_credit_modal.png')
        page.screenshot(path=shot4, full_page=False)
        print(f" -> Saved screenshot: {shot4}")

        # Submit historical credit note
        submit_credit_btn = page.locator('#credit-modal button[type="submit"]')
        submit_credit_btn.click()

        # Wait for toast
        page.wait_for_selector('.toast.success', timeout=5000)
        toast_text = page.locator('.toast.success').inner_text()
        print(f" -> Success Toast Observed: {toast_text}")
        page.wait_for_timeout(1500)

        # Step 6: Direct Printable A4 Tax Invoice Page
        print(f"\n[Step 6] Navigating directly to A4 Printable Tax Invoice /api/invoices/{invoice_id}/printable...")
        page.goto(f'http://127.0.0.1:3000/api/invoices/{invoice_id}/printable', wait_until='networkidle')
        assert 'فاتورة ضريبية' in page.content(), "Printable invoice must render Arabic tax invoice header"
        assert page.locator('img[alt="ZATCA QR Code"]').is_visible(), "Embedded visual QR code must render on printable page"

        shot5 = os.path.join(OUTPUT_DIR, '05_printable_a4_tax_invoice.png')
        page.screenshot(path=shot5, full_page=True)
        print(f" -> Saved screenshot: {shot5}")

        # Step 7: Pre-Flight Debugger Tool
        print("\n[Step 7] Navigating to ZATCA Pre-Flight Debugger /debugger...")
        page.goto('http://127.0.0.1:3000/debugger', wait_until='networkidle')
        assert 'ZATCA Pre-Flight Debugger' in page.content(), "Debugger interface must load"

        shot6 = os.path.join(OUTPUT_DIR, '06_zatca_preflight_debugger.png')
        page.screenshot(path=shot6, full_page=True)
        print(f" -> Saved screenshot: {shot6}")

        # Step 8: WhatsApp Floating Button Verification
        print("\n[Step 8] Verifying Floating WhatsApp Support Widget...")
        page.goto('http://127.0.0.1:3000/portal', wait_until='networkidle')
        whatsapp_link = page.locator('a[href*="wa.me/966500000000"]')
        assert whatsapp_link.is_visible(), "Floating WhatsApp button must be visible in viewport"
        print(f" -> Floating WhatsApp support button confirmed visible at href: {whatsapp_link.get_attribute('href')}")

        browser.close()

    print("\n==================================================================")
    print("ALL REAL HUMAN BROWSER USER FLOWS COMPLETED AND VERIFIED 100%!")
    print(f"Screenshots saved to: {OUTPUT_DIR}")
    print("==================================================================")

if __name__ == '__main__':
    run_human_browser_journey()
