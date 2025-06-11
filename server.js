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
