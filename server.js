const express = require("express");
const mongoose = require("mongoose");
const cors = require("cors");
require("dotenv").config();

const app = express();
const apiRouter = express.Router();
const PORT = process.env.PORT || 3000;

// Middleware
app.use(cors());
app.use(express.json());

// MongoDB connection
mongoose.connect(
  process.env.MONGODB_URI || "mongodb://localhost:27017/cleaning-schedule",
  {
    useNewUrlParser: true,
    useUnifiedTopology: true,
  }
);

// Schedule Schema
const scheduleSchema = new mongoose.Schema({
  people: [
    {
      type: String,
      required: true,
    },
  ],
  startDate: {
    type: Date,
    required: true,
  },
  createdAt: {
    type: Date,
    default: Date.now,
  },
  updatedAt: {
    type: Date,
    default: Date.now,
  },
});

const Schedule = mongoose.model("Schedule", scheduleSchema);

// API Key middleware for protected routes
const requireApiKey = (req, res, next) => {
  const apiKey = req.header("X-API-Key");

  if (!apiKey) {
    return res.status(401).json({ error: "API key required" });
  }

  if (apiKey !== process.env.API_KEY) {
    return res.status(403).json({ error: "Invalid API key" });
  }

  next();
};

// Helper function to get Monday of a given date (in UTC)
const getMondayOfWeek = (date) => {
  const d = new Date(date);
  // Force UTC calculation
  const day = d.getUTCDay();
  const diff = d.getUTCDate() - day + (day === 0 ? -6 : 1); // Adjust when day is Sunday
  const monday = new Date(
    Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), diff, 0, 0, 0, 0)
  );
  return monday;
};

// Helper function to add days to a date (in UTC)
const addDays = (date, days) => {
  const result = new Date(date);
  result.setUTCDate(result.getUTCDate() + days);
  return result;
};

// Helper function to calculate current rotation
const getCurrentRotation = (startDate, people) => {
  const now = new Date();
  const start = new Date(startDate);

  // Find Monday of the week containing start date
  const startMonday = getMondayOfWeek(start);

  // Calculate how many days have passed since start Monday
  const daysSinceStart = Math.floor(
    (now - startMonday) / (1000 * 60 * 60 * 24)
  );

  // Each rotation is 14 days (2 weeks)
  const rotationNumber = Math.floor(daysSinceStart / 14);
  const personIndex = rotationNumber % people.length;

  // Calculate this rotation's start and end dates
  const rotationStart = addDays(startMonday, rotationNumber * 14);
  const rotationEnd = addDays(rotationStart, 13); // 14 days total (0-13)
  rotationEnd.setUTCHours(23, 59, 59, 999);

  return {
    currentPerson: people[personIndex],
    currentPersonIndex: personIndex,
    rotationNumber: rotationNumber + 1,
    periodStart: rotationStart,
    periodEnd: rotationEnd,
    weeksSinceStart: Math.floor(daysSinceStart / 7),
    daysSinceStart,
    isActive: now >= rotationStart && now <= rotationEnd,
  };
};

// Helper function to get upcoming rotations
const getUpcomingRotations = (startDate, people, count = 5) => {
  const start = new Date(startDate);
  const now = new Date();
  const startMonday = getMondayOfWeek(start);

  // Calculate current rotation number
  const daysSinceStart = Math.floor(
    (now - startMonday) / (1000 * 60 * 60 * 24)
  );
  const currentRotationNumber = Math.floor(daysSinceStart / 14);

  const rotations = [];

  // Start from the NEXT rotation (currentRotationNumber + 1)
  for (let i = 1; i <= count; i++) {
    const rotationNumber = currentRotationNumber + i;
    const personIndex = rotationNumber % people.length;

    const rotationStart = addDays(startMonday, rotationNumber * 14);
    const rotationEnd = addDays(rotationStart, 13);
    rotationEnd.setUTCHours(23, 59, 59, 999);

    rotations.push({
      person: people[personIndex],
      rotationNumber: rotationNumber + 1,
      periodStart: rotationStart,
      periodEnd: rotationEnd,
      isCurrent: false, // These are all future rotations
    });
  }

  return rotations;
};

// Routes - now all attached to apiRouter

// GET /api/schedule - Get current schedule info (public)
apiRouter.get("/schedule", async (req, res) => {
  try {
    const schedule = await Schedule.findOne().sort({ createdAt: -1 });

    if (!schedule) {
      return res.status(404).json({ error: "No schedule found" });
    }

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );
    const upcomingRotations = getUpcomingRotations(
      schedule.startDate,
      schedule.people
    );

    res.json({
      people: schedule.people,
      startDate: schedule.startDate,
      currentRotation,
      upcomingRotations,
      createdAt: schedule.createdAt,
      updatedAt: schedule.updatedAt,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// GET /api/current - Get current person responsible (public)
apiRouter.get("/current", async (req, res) => {
  try {
    const schedule = await Schedule.findOne().sort({ createdAt: -1 });

    if (!schedule) {
      return res.status(404).json({ error: "No schedule found" });
    }

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );

    res.json({
      currentPerson: currentRotation.currentPerson,
      rotationNumber: currentRotation.rotationNumber,
      periodStart: currentRotation.periodStart,
      periodEnd: currentRotation.periodEnd,
      isActive: currentRotation.isActive,
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// POST /api/schedule - Create or update schedule (protected)
apiRouter.post("/schedule", requireApiKey, async (req, res) => {
  try {
    const { people, startDate } = req.body;

    // Validation
    if (!people || !Array.isArray(people) || people.length === 0) {
      return res
        .status(400)
        .json({ error: "People array is required and cannot be empty" });
    }

    if (!startDate) {
      return res.status(400).json({ error: "Start date is required" });
    }

    const parsedStartDate = new Date(startDate);
    if (isNaN(parsedStartDate.getTime())) {
      return res.status(400).json({ error: "Invalid start date format" });
    }

    // Remove any existing schedule and create new one
    await Schedule.deleteMany({});

    const schedule = new Schedule({
      people: people.map((person) => person.trim()),
      startDate: parsedStartDate,
      updatedAt: new Date(),
    });

    await schedule.save();

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );

    res.status(201).json({
      message: "Schedule created successfully",
      schedule: {
        people: schedule.people,
        startDate: schedule.startDate,
        currentRotation,
        createdAt: schedule.createdAt,
        updatedAt: schedule.updatedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// PUT /api/schedule - Update existing schedule (protected)
apiRouter.put("/schedule", requireApiKey, async (req, res) => {
  try {
    const { people, startDate } = req.body;

    const schedule = await Schedule.findOne().sort({ createdAt: -1 });

    if (!schedule) {
      return res.status(404).json({ error: "No schedule found to update" });
    }

    // Update fields if provided
    if (people && Array.isArray(people) && people.length > 0) {
      schedule.people = people.map((person) => person.trim());
    }

    if (startDate) {
      const parsedStartDate = new Date(startDate);
      if (isNaN(parsedStartDate.getTime())) {
        return res.status(400).json({ error: "Invalid start date format" });
      }
      schedule.startDate = parsedStartDate;
    }

    schedule.updatedAt = new Date();
    await schedule.save();

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );

    res.json({
      message: "Schedule updated successfully",
      schedule: {
        people: schedule.people,
        startDate: schedule.startDate,
        currentRotation,
        createdAt: schedule.createdAt,
        updatedAt: schedule.updatedAt,
      },
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// DELETE /api/schedule - Delete schedule (protected)
apiRouter.delete("/schedule", requireApiKey, async (req, res) => {
  try {
    const result = await Schedule.deleteMany({});

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: "No schedule found to delete" });
    }

    res.json({ message: "Schedule deleted successfully" });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// Health check
apiRouter.get("/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

// Mount the API router at /api
app.use("/api", apiRouter);

// Serve a nice web page at the root that shows the current schedule
app.get("/", async (req, res) => {
  try {
    const schedule = await Schedule.findOne().sort({ createdAt: -1 });

    if (!schedule) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Cleaning Schedule</title>
          <style>
            body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; 
                   background: #f0f2f5; margin: 0; padding: 20px; }
            .container { max-width: 400px; margin: 0 auto; background: white; 
                        border-radius: 15px; padding: 20px; box-shadow: 0 2px 10px rgba(0,0,0,0.1); }
            .header { text-align: center; margin-bottom: 20px; }
            .emoji { font-size: 2em; margin-bottom: 10px; }
            .title { font-size: 1.5em; font-weight: bold; color: #1f2937; }
            .message { text-align: center; color: #6b7280; font-size: 1.1em; }
          </style>
        </head>
        <body>
          <div class="container">
            <div class="header">
              <div class="emoji">🧹</div>
              <div class="title">Cleaning Schedule</div>
            </div>
            <div class="message">No schedule found. Please create one first.</div>
          </div>
        </body>
        </html>
      `);
    }

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );
    const upcomingRotations = getUpcomingRotations(
      schedule.startDate,
      schedule.people,
      5
    );

    const formatDateForWeb = (dateString) => {
      const date = new Date(dateString);
      const options = {
        month: "long",
        day: "numeric",
        timeZone: "UTC",
      };
      return date.toLocaleDateString("en-US", options);
    };

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cleaning Schedule</title>
        <style>
          * { box-sizing: border-box; }
          body { 
            font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif; 
            margin: 0; padding: 20px; min-height: 100vh;
          }
          .container { 
            max-width: 450px; margin: 0 auto; 
            background: white; border-radius: 20px; 
            overflow: hidden; box-shadow: 0 10px 15px rgba(0,0,0,0.2);
          }
          .header { 
            background: linear-gradient(135deg, #25d366 0%, #128c7e 100%);
            color: white; padding: 25px 20px; text-align: center;
          }
          .header-emoji { font-size: 2.5em; margin-bottom: 10px; }
          .header-title { font-size: 1.8em; font-weight: 600; margin: 0; }
          .header-subtitle { opacity: 0.9; margin-top: 5px; font-size: 0.9em; }
          
          .message-container { padding: 20px; }
          .message { 
            background: #dcf8c6; border-radius: 15px 15px 5px 15px;
            padding: 15px; margin-bottom: 15px; position: relative;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          }
          .message-header { 
            font-weight: 600; color: #075e54; margin-bottom: 8px;
            font-size: 1.1em; display: flex; align-items: center;
          }
          .message-emoji { margin-right: 8px; font-size: 1.2em; }
          .message-content { color: #303030; line-height: 1.4; }
          .message-content strong { color: #075e54; }
          
          .upcoming { 
            background: #fff3cd; border-radius: 15px 15px 5px 15px;
            padding: 15px; margin-bottom: 15px;
            box-shadow: 0 2px 5px rgba(0,0,0,0.1);
          }
          .upcoming::after {
            content: ''; position: absolute; bottom: 0; right: -8px;
            width: 0; height: 0; border-left: 8px solid #fff3cd;
            border-bottom: 8px solid transparent;
          }
          
          .upcoming-item { 
            display: flex; align-items: center; justify-content: space-between; padding: 4px 0;
          }
          .upcoming-item:last-child { border-bottom: none; }
          .upcoming-name { font-weight: 600; color: #856404; margin-right: 8px; }
          .upcoming-date { color: #6c757d; font-size: 0.9em; }
          
          .footer { 
            padding: 15px 20px; background: #f8f9fa; 
            text-align: center; color: #6c757d; font-size: 0.8em;
            border-top: 1px solid #e9ecef;
          }
          .refresh-btn {
            background: #25d366; color: white; border: none;
            padding: 8px 16px; border-radius: 20px; cursor: pointer;
            font-size: 0.9em; margin-top: 10px;
          }
          .refresh-btn:hover { background: #128c7e; }
          
          @media (max-width: 480px) {
            .container { margin: 10px; border-radius: 15px; }
            body { padding: 10px; }
          }
        </style>
        <script defer src="https://umami.koev.cz/script.js" data-website-id="e8d3a665-143f-42a5-aaf7-32dc9c294431"></script>
        <script>
          function refreshSchedule() {
            window.location.reload();
          }
          // Auto-refresh every 5 minutes
          setTimeout(refreshSchedule, 300000);
        </script>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="header-emoji">🧹</div>
            <h1 class="header-title">Cleaning Schedule</h1>
            <div class="header-subtitle">House cleaning rotation</div>
          </div>
          
          <div class="message-container">
            <div class="message">
              <div class="message-header">
                <span class="message-emoji">🎯</span>
                Current Responsibility
              </div>
              <div class="message-content">
                <strong>${
                  currentRotation.currentPerson
                }</strong> is responsible for cleaning<br>
                📅 ${formatDateForWeb(
                  currentRotation.periodStart
                )} - ${formatDateForWeb(currentRotation.periodEnd)}<br>
              </div>
            </div>
            
            <div class="upcoming">
              <div class="message-header">
                <span class="message-emoji">🔮</span>
                Upcoming Rotations
              </div>
              ${upcomingRotations
                .map((rotation) => {
                  return `
                  <div class="upcoming-item">
                    <span class="upcoming-name">${rotation.person}</span>
                    <span class="upcoming-date">${formatDateForWeb(
                      rotation.periodStart
                    )} - ${formatDateForWeb(rotation.periodEnd)}</span>
                  </div>
                `;
                })
                .join("")}
            </div>
          </div>
          
          <div class="footer">
            <div>Last updated: ${new Date().toLocaleString("en-US", {
              timeZone: "Europe/Prague",
            })}</div>
            <button class="refresh-btn" onclick="refreshSchedule()">🔄 Refresh</button>
            <div style="margin-top: 10px;">
              <small>👥 ${schedule.people.join(" • ")}</small>
            </div>
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Error</title></head>
      <body style="font-family: Arial; text-align: center; padding: 50px;">
        <h1>❌ Error</h1>
        <p>Could not load cleaning schedule: ${error.message}</p>
      </body></html>
    `);
  }
});

// Add this route before the root "/" route in your Express app

// E-ink optimized display route
app.get("/eink", async (req, res) => {
  try {
    const schedule = await Schedule.findOne().sort({ createdAt: -1 });

    if (!schedule) {
      return res.send(`
        <!DOCTYPE html>
        <html lang="en">
        <head>
          <meta charset="UTF-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Cleaning Schedule</title>
          <style>
            body { 
              font-family: 'Courier New', monospace; 
              background: white;
              color: black;
              margin: 0;
              padding: 40px;
              font-size: 32px;
              line-height: 1.6;
            }
            .container { 
              max-width: 800px;
              margin: 0 auto;
              text-align: center;
            }
            h1 { 
              font-size: 72px;
              margin: 40px 0;
              font-weight: bold;
            }
          </style>
        </head>
        <body>
          <div class="container">
            <h1>NO SCHEDULE</h1>
            <p>Please create a schedule first</p>
          </div>
        </body>
        </html>
      `);
    }

    const currentRotation = getCurrentRotation(
      schedule.startDate,
      schedule.people
    );
    const upcomingRotations = getUpcomingRotations(
      schedule.startDate,
      schedule.people,
      3 // Fewer rotations for e-ink display
    );

    const formatDateForEink = (dateString) => {
      const date = new Date(dateString);
      const options = {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      };
      return date.toLocaleDateString("en-US", options);
    };

    const html = `
      <!DOCTYPE html>
      <html lang="en">
      <head>
        <meta charset="UTF-8">
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <title>Cleaning Schedule</title>
        <style>
          * { 
            box-sizing: border-box;
            margin: 0;
            padding: 0;
          }
          body { 
            font-family: 'Courier New', Courier, monospace; 
            background: white;
            color: black;
            padding: 60px 40px;
            font-size: 28px;
            line-height: 1.5;
          }
          .container { 
            max-width: 1000px;
            margin: 0 auto;
          }
          
          .header {
            text-align: center;
            margin-bottom: 80px;
            padding-bottom: 40px;
            border-bottom: 8px solid black;
          }
          .title { 
            font-size: 96px;
            font-weight: bold;
            margin-bottom: 20px;
            letter-spacing: -2px;
          }
          .subtitle {
            font-size: 36px;
            margin-top: 10px;
          }
          
          .current-section {
            margin-bottom: 80px;
            padding: 60px;
            border: 8px solid black;
            text-align: center;
          }
          .section-label {
            font-size: 42px;
            font-weight: bold;
            margin-bottom: 40px;
            text-transform: uppercase;
            letter-spacing: 2px;
          }
          .current-name {
            font-size: 120px;
            font-weight: bold;
            margin: 40px 0;
            line-height: 1.2;
          }
          .current-dates {
            font-size: 48px;
            margin-top: 30px;
          }
          
          .upcoming-section {
            margin-top: 60px;
          }
          .upcoming-title {
            font-size: 42px;
            font-weight: bold;
            margin-bottom: 40px;
            text-transform: uppercase;
            letter-spacing: 2px;
            border-bottom: 4px solid black;
            padding-bottom: 20px;
          }
          .upcoming-item {
            display: flex;
            justify-content: space-between;
            align-items: center;
            padding: 30px 0;
            border-bottom: 2px solid black;
            font-size: 40px;
          }
          .upcoming-item:last-child {
            border-bottom: none;
          }
          .upcoming-name {
            font-weight: bold;
            flex: 0 0 40%;
          }
          .upcoming-dates {
            flex: 0 0 55%;
            text-align: right;
            font-size: 36px;
          }
          
          .footer {
            margin-top: 80px;
            padding-top: 40px;
            border-top: 4px solid black;
            text-align: center;
            font-size: 28px;
          }
          
          /* Print optimization for e-ink */
          @media print {
            body { padding: 40px; }
          }
        </style>
        <script>
          // Auto-refresh every 30 minutes for e-ink
          setTimeout(() => window.location.reload(), 1800000);
        </script>
      </head>
      <body>
        <div class="container">
          <div class="header">
            <div class="title">CLEANING</div>
            <div class="subtitle">House Schedule</div>
          </div>
          
          <div class="current-section">
            <div class="section-label">Current Week</div>
            <div class="current-name">${currentRotation.currentPerson}</div>
            <div class="current-dates">
              ${formatDateForEink(
                currentRotation.periodStart
              )} - ${formatDateForEink(currentRotation.periodEnd)}
            </div>
          </div>
          
          <div class="upcoming-section">
            <div class="upcoming-title">Upcoming</div>
            ${upcomingRotations
              .map((rotation) => {
                return `
              <div class="upcoming-item">
                <div class="upcoming-name">${rotation.person}</div>
                <div class="upcoming-dates">${formatDateForEink(
                  rotation.periodStart
                )} - ${formatDateForEink(rotation.periodEnd)}</div>
              </div>
            `;
              })
              .join("")}
          </div>
          
          <div class="footer">
            Updated: ${new Date().toLocaleDateString("en-US", {
              month: "short",
              day: "numeric",
              hour: "2-digit",
              minute: "2-digit",
              timeZone: "Europe/Prague",
            })}
          </div>
        </div>
      </body>
      </html>
    `;

    res.send(html);
  } catch (error) {
    res.status(500).send(`
      <!DOCTYPE html>
      <html><head><title>Error</title>
      <style>
        body { 
          font-family: 'Courier New', monospace; 
          background: white; 
          color: black; 
          text-align: center; 
          padding: 100px 40px;
          font-size: 48px;
        }
        h1 { font-size: 96px; margin-bottom: 40px; }
      </style>
      </head>
      <body>
        <h1>ERROR</h1>
        <p>Could not load schedule</p>
      </body></html>
    `);
  }
});

// Error handling middleware
app.use((err, req, res, next) => {
  console.error(err.stack);
  res.status(500).json({ error: "Something went wrong!" });
});

// 404 handler
app.use((req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// Start server
app.listen(PORT, () => {
  console.log(`Cleaning Schedule API running on port ${PORT}`);
  console.log(`Environment: ${process.env.NODE_ENV || "development"}`);
});

module.exports = app;
