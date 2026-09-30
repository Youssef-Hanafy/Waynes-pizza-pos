import java.util.Properties

plugins {
    alias(libs.plugins.android.application)
}

// The live POS.  Store builds (release) always open this.
val livePosUrl = "https://app.hanafymedia.com/pos"
// Test builds (debug) can open another address, set in android/local.properties
// (this Mac only, never committed), e.g. the dev server seen from the emulator:
//     waynesPosUrl=http://10.0.2.2:3000/pos
// Read from the file next to this app module, so it works whichever
// Android Studio project the module is opened from.
val localProperties = Properties().apply {
    // Read through Gradle so an edit to the file is picked up on the next build (configuration cache).
    val text = providers.fileContents(layout.projectDirectory.file("../local.properties")).asText.orNull
    if (text != null) load(text.reader())
}
val debugPosUrl: String = (localProperties.getProperty("waynesPosUrl")
    ?: providers.gradleProperty("waynesPosUrl").orNull
    ?: livePosUrl).trim()

android {
    namespace = "com.waynespizza.pos"
    compileSdk {
        version = release(37)
    }

    defaultConfig {
        applicationId = "com.waynespizza.pos"
        minSdk = 26
        targetSdk = 37
        versionCode = 2
        versionName = "1.1"
        // The POS the app opens (see livePosUrl / debugPosUrl above).
        buildConfigField("String", "POS_URL", "\"$livePosUrl\"")
    }

    buildFeatures {
        buildConfig = true
    }

    buildTypes {
        debug {
            // 10.0.2.2 is this Mac as seen from the emulator; plain http to it is allowed in debug builds only.
            buildConfigField("String", "POS_URL", "\"$debugPosUrl\"")
        }
        release {
            optimization {
                enable = false
            }
        }
    }
    compileOptions {
        sourceCompatibility = JavaVersion.VERSION_11
        targetCompatibility = JavaVersion.VERSION_11
    }
}

dependencies {
    // Stripe Reader M2 (Bluetooth card reader). https://github.com/stripe/stripe-terminal-android
    implementation("com.stripe:stripeterminal:5.8.1")
}
