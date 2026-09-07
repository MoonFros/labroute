/**
 * ELAborate - Donation Widget Controller
 */

document.addEventListener('DOMContentLoaded', () => {
  const amountBtns = document.querySelectorAll('.amount-btn');
  const customAmountGroup = document.getElementById('customAmountGroup');
  const customAmountInput = document.getElementById('customAmount');
  const donationForm = document.getElementById('donationForm');
  
  let selectedAmount = 2500; // Default active amount

  // 1. Handle Amount Button Clicks
  amountBtns.forEach(btn => {
    btn.addEventListener('click', (e) => {
      // Remove active class from all
      amountBtns.forEach(b => b.classList.remove('active'));
      // Add active to clicked
      e.target.classList.add('active');

      const value = e.target.getAttribute('data-val');

      if (value === 'custom') {
        customAmountGroup.style.display = 'flex';
        selectedAmount = customAmountInput.value || 0;
        customAmountInput.focus();
      } else {
        customAmountGroup.style.display = 'none';
        selectedAmount = parseInt(value, 10);
      }
    });
  });

  // 2. Handle Custom Amount Input
  customAmountInput.addEventListener('input', (e) => {
    selectedAmount = parseInt(e.target.value, 10) || 0;
  });

  // 3. Handle Form Submission
  donationForm.addEventListener('submit', (e) => {
    e.preventDefault();

    const name = document.getElementById('donorName').value.trim() || 'Anonymous Scholar';
    const email = document.getElementById('donorEmail').value.trim();

    if (selectedAmount < 500) {
      alert("Minimum contribution amount is ₦500. Thank you for your support!");
      return;
    }

    // Call open-ended payment processor
    processPayment({
      amount: selectedAmount,
      name: name,
      email: email
    });
  });

});

/**
 * OPEN-ENDED PAYMENT FUNCTION
 * Hook your Paystack, Flutterwave, or Stripe JS SDK here.
 */
function processPayment(donationDetails) {
  console.log("Initializing payment with data:", donationDetails);
  
  // MOCK UI STATE CHANGE (Change button text while loading)
  const payBtn = document.getElementById('payButton');
  const originalHtml = payBtn.innerHTML;
  payBtn.innerHTML = `<span>Connecting to Gateway...</span>`;
  payBtn.style.opacity = '0.7';
  payBtn.disabled = true;

  // Simulate API delay, replace this setTimeout with your actual Gateway initialization
  setTimeout(() => {
    alert(`Thank you, ${donationDetails.name}! Preparing redirect to secure checkout for ₦${donationDetails.amount}...`);
    
    // Reset button
    payBtn.innerHTML = originalHtml;
    payBtn.style.opacity = '1';
    payBtn.disabled = false;
    
    /* 
    ==================================================
    Example Paystack Implementation:
    ==================================================
    let handler = PaystackPop.setup({
      key: 'pk_test_xxxxxxxxxx',
      email: donationDetails.email,
      amount: donationDetails.amount * 100, // Paystack expects kobo
      currency: "NGN",
      callback: function(response) {
        alert('Payment complete! Reference: ' + response.reference);
      },
      onClose: function() {
        alert('Transaction was not completed, window closed.');
      }
    });
    handler.openIframe();
    */

  }, 1000);
}