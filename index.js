const express = require("express");
const connectToMongo = require("./db");
const app = express();
require("dotenv").config();

const { getEsewaPaymentHash, verifyEsewaPayment } = require("./esewa");
const Payment = require("./paymentModel");
const Support = require("./supportModel");

const PORT = Number(process.env.PORT) || 3001;
const ESEWA_FORM_URL = `${process.env.ESEWA_GATEWAY_URL}/api/epay/main/v2/form`;

app.set("trust proxy", true);
app.use(express.json());

connectToMongo();

function getPublicBaseUrl(req) {
  if (process.env.APP_BASE_URL) {
    return process.env.APP_BASE_URL.replace(/\/+$/, "");
  }

  return `${req.protocol}://${req.get("host")}`;
}

function buildCallbackUrls(req, purchaseId) {
  const baseUrl = getPublicBaseUrl(req);

  return {
    success_url: `${baseUrl}/payment-success`,
    failure_url: `${baseUrl}/failure?purchaseId=${encodeURIComponent(purchaseId)}`,
  };
}

app.post("/initialize-esewa", async (req, res) => {
  try {
    const { totalPrice, name, message } = req.body;
    const amount = Number(totalPrice);

    if (!Number.isFinite(amount) || amount <= 0) {
      return res.status(400).json({
        success: false,
        message: "Please enter a valid donation amount.",
      });
    }

    const supportData = await Support.create({
      paymentMethod: "esewa",
      amount,
      name: name?.trim() || "Anonymous",
      message: message?.trim() || "",
    });

    const paymentInitiate = await getEsewaPaymentHash({
      amount,
      transaction_uuid: supportData._id,
    });

    res.json({
      success: true,
      payment: paymentInitiate,
      supportData,
      esewaFormUrl: ESEWA_FORM_URL,
      callbackUrls: buildCallbackUrls(req, supportData._id),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      error: error.message,
    });
  }
});

app.get("/retry-esewa/:purchaseId", async (req, res) => {
  try {
    const previousSupport = await Support.findById(req.params.purchaseId);

    if (!previousSupport) {
      return res.status(404).json({
        success: false,
        message: "Support record not found.",
      });
    }

    if (previousSupport.status === "completed") {
      return res.status(400).json({
        success: false,
        message: "This payment has already been completed.",
      });
    }

    const supportData = await Support.create({
      paymentMethod: previousSupport.paymentMethod,
      amount: previousSupport.amount,
      name: previousSupport.name,
      message: previousSupport.message,
      status: "pending",
    });

    await Support.findByIdAndUpdate(previousSupport._id, {
      $set: { status: "cancelled" },
    });

    const paymentInitiate = await getEsewaPaymentHash({
      amount: supportData.amount,
      transaction_uuid: supportData._id,
    });

    res.json({
      success: true,
      payment: paymentInitiate,
      supportData,
      esewaFormUrl: ESEWA_FORM_URL,
      callbackUrls: buildCallbackUrls(req, supportData._id),
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "Could not retry the payment.",
      error: error.message,
    });
  }
});

app.get("/complete-payment", async (req, res) => {
  const { data } = req.query;

  try {
    const paymentInfo = await verifyEsewaPayment(data);
    const supportData = await Support.findById(
      paymentInfo.response.transaction_uuid
    );

    if (!supportData) {
      return res.status(500).json({
        success: false,
        message: "Support record not found",
      });
    }

    const paymentData = await Payment.findOneAndUpdate(
      { transactionId: paymentInfo.decodedData.transaction_code },
      {
        $setOnInsert: {
          transactionId: paymentInfo.decodedData.transaction_code,
          supportId: paymentInfo.response.transaction_uuid,
          amount: supportData.amount,
          verificationData: paymentInfo,
          paymentGateway: "esewa",
          status: "success",
        },
      },
      { new: true, upsert: true }
    );

    await Support.findByIdAndUpdate(
      paymentInfo.response.transaction_uuid,
      { $set: { status: "completed" } }
    );

    res.json({
      success: true,
      message: "Payment successful",
      paymentData,
      support: supportData,
    });
  } catch (error) {
    res.status(500).json({
      success: false,
      message: "An error occurred during payment verification",
      error: error.message,
    });
  }
});

app.get("/payment-success", function (req, res) {
  res.sendFile(__dirname + "/success.html");
});

app.get("/failure", function (req, res) {
  res.status(400).sendFile(__dirname + "/failure.html");
});

app.get("/", function (req, res) {
  res.sendFile(__dirname + "/coffee.html");
});

app.listen(PORT, () => {
  console.log(`Backend listening on port ${PORT}`);
});
