import { ScrollView, StyleSheet, Text, View } from "react-native";
import { TrainingGroupsManager } from "../../../components/coach/TrainingGroupsManager";

export default function CoachTrainingGroupsTab() {
  return (
    <View style={styles.container}>
      <ScrollView contentContainerStyle={styles.scrollContent} keyboardShouldPersistTaps="handled">
        <View style={styles.pageHeader}>
          <Text style={styles.title}>Training Groups</Text>
          <Text style={styles.subtitle}>
            Create and maintain coach-managed athlete groups for filters, planning, mileage, and logs.
          </Text>
        </View>
        <TrainingGroupsManager />
      </ScrollView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: { flex: 1, backgroundColor: "#f3f6fb" },
  scrollContent: {
    padding: 12,
    gap: 12,
    paddingBottom: 40,
  },
  pageHeader: {
    borderWidth: 1,
    borderColor: "#dbe3ef",
    borderRadius: 16,
    backgroundColor: "#fff",
    padding: 16,
    gap: 4,
  },
  title: {
    fontSize: 22,
    fontWeight: "900",
    color: "#172033",
  },
  subtitle: {
    color: "#68758d",
    fontWeight: "700",
    lineHeight: 20,
  },
});
